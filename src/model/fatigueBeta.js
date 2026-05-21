// ─────────────────────────────────────────────────────────────
// PER-GRIP FATIGUE BETA LEARNER
// ─────────────────────────────────────────────────────────────
// Replaces the population-curve + per-zone-shrinkage approach of
// perceivedFatigueLearning.js with a closed-loop online learner.
//
// Model:
//   For each grip, maintain a single scalar β ≥ 0 representing how
//   sharply cookedness suppresses capacity. The capacity multiplier
//   for a session prescribed under "cooked = c" (c ∈ [0, 10]) is:
//
//       multiplier(grip, c) = exp(-β_grip · c)
//
//   c = 0 → multiplier = 1 (no scale-down).
//   Larger β → steeper scale-down per cookedness point.
//
// Learning:
//   After a session, we look at rep 1 of set 1 (the cleanest signal —
//   reps 2+ are confounded by within-session protocol fatigue from
//   short rests). The residual is:
//
//       e = ln(actual_time_s / target_duration_s)
//
//   e > 0 → user outperformed prescription → β should DROP (engine
//           over-corrected for cookedness).
//   e < 0 → user undershot → β should RISE.
//   Magnitude scales with cooked c (a residual at c = 0 carries no
//   information about β).
//
//   Update rule (SGD on squared residual + L2 anchor):
//
//       β_new = β_old − η · e · c − λ · (β_old − β_prior)
//
//   Clamped to [0, BETA_MAX] so a single weird session can't blow
//   the model up.
//
// Storage:
//   user_settings.settings.fatigue_model = {
//     eta:        0.02,
//     lambda:     0.01,
//     Crusher:    { beta, beta_prior, n_obs, last_update },
//     Micro:      { beta, beta_prior, n_obs, last_update },
//     // additional grips materialize lazily on first observation
//   }
//
// Server-side mirror:
//   The same update rule is implemented as a Postgres trigger on
//   INSERT to reps so β converges even when the client isn't open
//   (e.g. background syncs of locally-queued reps). Client-side and
//   server-side updates should agree given the same inputs.

export const DEFAULT_ETA       = 0.02;
export const DEFAULT_LAMBDA    = 0.01;
export const DEFAULT_BETA      = 0.05;
export const BETA_MIN          = 0.0;
export const BETA_MAX          = 0.5;
export const COOKED_MIN        = 0;
export const COOKED_MAX        = 10;

// Build a cold-start fatigue model. Used by callers that find no
// `fatigue_model` block on user_settings (first-run or pre-migration).
export function defaultFatigueModel(grips = ["Crusher", "Micro"]) {
  const out = { eta: DEFAULT_ETA, lambda: DEFAULT_LAMBDA };
  for (const g of grips) {
    out[g] = {
      beta: DEFAULT_BETA,
      beta_prior: DEFAULT_BETA,
      n_obs: 0,
      last_update: null,
    };
  }
  return out;
}

// Read the live β for a grip out of a fatigue_model object, with
// fallbacks. Returns DEFAULT_BETA when the model or grip is missing
// so consumers can compute a multiplier without null-checks at every
// call site.
export function currentBeta(model, grip) {
  if (!model || !grip) return DEFAULT_BETA;
  const g = model[grip];
  if (!g) return DEFAULT_BETA;
  const b = Number(g.beta);
  if (!Number.isFinite(b)) return DEFAULT_BETA;
  return clamp(b, BETA_MIN, BETA_MAX);
}

// Compute the capacity multiplier for a (grip, cooked) pair. Returns
// 1.0 (no scale-down) when cooked is null/undefined or 0, so it's
// safe to apply unconditionally:
//
//   prescribedLoad = freshLoad * capacityMultiplier(model, grip, cooked);
export function capacityMultiplier(model, grip, cooked) {
  if (cooked == null) return 1.0;
  const c = clamp(Number(cooked), COOKED_MIN, COOKED_MAX);
  if (!(c > 0)) return 1.0;
  const beta = currentBeta(model, grip);
  return Math.exp(-beta * c);
}

// Apply one SGD update to β based on a rep-1 observation. Pure: takes
// the current model, returns a new model object with the updated grip
// block. Caller persists the result.
//
// Inputs:
//   model           — current fatigue_model block (or null → defaults)
//   grip            — grip whose β to update
//   cooked          — cookedness value the user submitted for this
//                     session (0–10). Required; if 0 the update is a
//                     no-op (no learning signal at fresh).
//   rep1_actual_s   — actual_time_s of rep 1 of set 1
//   rep1_target_s   — target_duration of rep 1 of set 1
//
// Returns: new fatigue_model object. Other grips untouched. n_obs
// increments and last_update gets the current ISO timestamp.
export function updateBeta(model, grip, cooked, rep1_actual_s, rep1_target_s) {
  const safeModel = model && typeof model === "object"
    ? { ...model }
    : defaultFatigueModel([grip]);

  // Ensure config defaults if the model JSON predates them.
  const eta = Number.isFinite(Number(safeModel.eta)) ? Number(safeModel.eta) : DEFAULT_ETA;
  const lambda = Number.isFinite(Number(safeModel.lambda)) ? Number(safeModel.lambda) : DEFAULT_LAMBDA;
  safeModel.eta = eta;
  safeModel.lambda = lambda;

  const c = Number(cooked);
  const actual = Number(rep1_actual_s);
  const target = Number(rep1_target_s);

  // No-op guard: missing/invalid inputs, or cooked = 0 (no information
  // about β at fresh). We still ensure the grip block exists, so the
  // next session starts from a stable shape.
  if (!grip
      || !Number.isFinite(c) || c < COOKED_MIN || c > COOKED_MAX
      || !Number.isFinite(actual) || actual <= 0
      || !Number.isFinite(target) || target <= 0) {
    safeModel[grip] = safeModel[grip] || {
      beta: DEFAULT_BETA, beta_prior: DEFAULT_BETA, n_obs: 0, last_update: null,
    };
    return safeModel;
  }

  const gripBlock = safeModel[grip] || {
    beta: DEFAULT_BETA, beta_prior: DEFAULT_BETA, n_obs: 0, last_update: null,
  };
  const betaOld   = Number.isFinite(Number(gripBlock.beta)) ? Number(gripBlock.beta) : DEFAULT_BETA;
  const betaPrior = Number.isFinite(Number(gripBlock.beta_prior)) ? Number(gripBlock.beta_prior) : DEFAULT_BETA;

  // c = 0 carries no β signal — only update n_obs/timestamp via
  // separate path (we already returned above for c < 0/NaN; explicit
  // c == 0 falls through to the update below where e·c = 0, so β
  // moves only by the L2 anchor. That's the correct behavior: a
  // confirmed fresh session pulls β gently toward the prior.)

  const e = Math.log(actual / target);
  const sgdStep = eta * e * c;          // residual × cookedness
  const l2Step  = lambda * (betaOld - betaPrior); // anchor to prior
  let betaNew   = betaOld - sgdStep - l2Step;
  betaNew = clamp(betaNew, BETA_MIN, BETA_MAX);

  safeModel[grip] = {
    ...gripBlock,
    beta:        betaNew,
    beta_prior:  betaPrior,
    n_obs:       (Number(gripBlock.n_obs) || 0) + 1,
    last_update: new Date().toISOString(),
  };
  return safeModel;
}

function clamp(x, lo, hi) {
  if (!Number.isFinite(x)) return lo;
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}
