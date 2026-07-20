# Recovery-model validation — nonlinear constant-force solver

Context: PR #36 replaced the linear `time = firstRepTime × capacityFraction`
rep-time predictor with a nonlinear constant-force force-duration solver
(`predictRepTimes` in `src/model/fatigue.js`), now shared by the live
forecast and the personal recovery-tau fitter. That swap invalidated the
old LOO-CV numbers (which described the retired linear predictor) and put
the recovery **gap** (observed − predicted rep-2/rep-1 ratio) on a new
scale, so two things needed re-checking:

1. Do **personal** recovery taus still beat the **population** prior on
   held-out sessions under the nonlinear solver?
2. Is the ±`GAP_NOISE_BAND` "matches model" band (and the deload trigger
   that reads it) still the right size for the new residuals?

## Method

Time-separated, forward-chained (expanding-window) holdout — no leakage:
for each test set, the personal taus are fit **only on sessions from
strictly earlier calendar days**, then used to predict that set's
rep-2..N times. Compared against the population prior on the same sets.
"Mature" = a test set with ≥5 prior sets for the grip (comparable to the
fitter's `PRIOR_WEIGHT = 5`). Reuses the exact production code via
`src/model/__tests__/recoveryModel.validation.test.js` (self-skips in CI;
point `RECOVERY_VALIDATION_JSON` at an export to re-run). Dataset: ~5
months of the author's real sessions — Micro 90, Crusher 72 mature test
sets (Prime excluded: only a handful of sets, no mature history).

## 1. Personalization still helps (~10% out-of-sample)

| grip    | mature sets | RMSE personal | RMSE population | Δ       |
|---------|-------------|---------------|-----------------|---------|
| Micro   | 90          | 13.99 s       | 15.52 s         | **−9.9%** |
| Crusher | 72          | 31.03 s       | 34.31 s         | **−9.6%** |

Personalized recovery taus reduce held-out rep-time RMSE by ~10% on both
grips with real data. This is more modest than the retired linear LOO
figures (+20–44%), which were less honest (LOO, and under the wrong
predictor) — but ~10% forward-chained out-of-sample is a real, credible
gain. **Conclusion: keep personalization**, with the existing conservative
Bayesian shrinkage toward the population prior for sparse grips.

## 2. The ±10pp band was ~half the real noise → widened to ±15pp

Session-to-session gap noise under the nonlinear solver:

| grip    | gap mean | raw gap std | 3-session smoothed-gap std |
|---------|----------|-------------|-----------------------------|
| Micro   | +0.09    | 0.23        | ≈ 0.14                      |
| Crusher | +0.11    | 0.38        | ≈ 0.24                      |

The old `GAP_NOISE_BAND = 0.10` was tuned against the linear predictor's
residuals. Under the nonlinear model the smoothed-gap std is ≈ 0.14–0.24,
so **~two-thirds of on-track sessions fell "outside" ±0.10** — making the
chart band look perpetually breached and the deload trigger / recovery
early-warn needlessly twitchy. Widened to **±0.15** (≈ one smoothed-gap
sigma for the better-behaved grip): the smoothed line mostly sits inside
it, and the deload/early-warn trigger now needs a real dip below the
user's own baseline rather than noise.

Note a small **positive** gap bias (mean +0.09 to +0.11): observed rep-2
times run a touch longer than the nonlinear forecast — the user retains
slightly more than the model expects. Forward-chaining inflates this (the
model is fit on earlier, weaker sessions), and it shrinks in-sample; it is
**not** corrected here (a per-user offset on a phenomenological model is
over-fitting). The widened symmetric band absorbs it in practice.

## 3. Deload gate still behaves

The gate fires only when **every** measured grip's mean of its last
`DELOAD_MIN_SESSIONS` (=2) gaps is below `−GAP_NOISE_BAND`, i.e. a
cross-grip AND gate, with a lifting-volume spike required for "strong".
Widening the band to 0.15 makes each grip's trigger stricter (needs a
deeper dip), and the cross-grip AND gate already guards against one noisy
grip firing it. The synthetic deload tests (a collapsed t2/t1 ≈ 0.33 → gap
≈ −0.6, far below either band) still fire correctly; normal recovery
(gap ≈ 0) still does not. The 2-session window was left unchanged: it is
short, but the wider band + cross-grip gate keep it conservative, and
lengthening it would change the detector's documented behavior without a
clear win on this data.
