# Design Doc — Exercise Library & Climbing-Balance Engine

**Status:** Draft / vision
**Author:** Nathan (with Claude)
**Date:** 2026-06-14
**Repo:** `NTRENNER/finger-training`
**Touches:** `src/model/supportTraining.js`, the swap picker, `WorkoutTab`, history / CSV, future `src/model/climbingSkills.js`

---

## 1. Summary

Today each support workout (A / B / C) is a fixed list of exercises. This doc
proposes turning each workout into a set of **slots** — movement *needs* — where
each slot offers a **menu** of interchangeable exercises. Users pick what fits
their goals, equipment, and how their body feels, while a **balance engine**
keeps the selection honest against what climbing actually demands.

The same model is then applied a second time to **climbing skills and drills**,
which is arguably the higher-leverage half: most climbers under-train skill
relative to strength, and skill gaps cap grades more than power does.

The guiding constraint is the app's existing ethos — *frequency over dose, the
user self-gates, ship things that do real data work, keep the happy path one
tap.* The balance engine should **remove** decisions, not add them.

---

## 2. Why now / what already exists

The data model is ~80% of the way there. The current code already has the right
primitives:

- **`exercises` map** keyed by stable `id` — exercise identity is by id
  everywhere downstream (history, exDef indexes, the swap picker), so adding,
  retiring, or swapping definitions is already safe.
- **`tags`** on every exercise (e.g. `core`, `shoulder`, `power`, `explosive`,
  `hip`, `hamstring`) — the seed of a climbing-quality taxonomy.
- **`workouts`** as ordered exercise arrays with workout-level `tags`,
  `fatigueClass`, `fatigueCost`.
- **A swap picker** already referenced in code comments.
- **History + CSV export + `computeTagDaysSince` / `daysSinceLastOfType`** — the
  machinery needed to compute "what have I trained lately" already runs.

So this is mostly an *unlock* of existing structure, not a rebuild.

---

## 3. Core concept: slots, not fixed lists

Re-model each workout as a list of **slots**. A slot describes a *need*; one or
more exercises *satisfy* it. The workout stays coherent because every slot is
filled, but the user chooses how.

Illustrative slotting (to be refined):

- **Workout A — Strength Support:** vertical pull · horizontal pull · press ·
  hinge/legs · core · shoulder prehab
- **Workout B — Athletic Power:** vertical projection · horizontal projection ·
  lateral-plane power · rotational / throwing power · core tension
- **Workout C — Neural Strength Touch:** light versions of the above
  (pull · press · arm · core), tuned for low fatigue

Each slot exposes a **menu**: e.g. the B "vertical projection" slot offers
vertical jump (and historically box jump); the "core tension" slot offers front
lever, hanging leg raise, ab wheel, etc.

### Schema sketch

```js
// A slot the workout must fill.
{
  id: "coreTension",
  name: "Core tension",
  // exercises whose ids satisfy this slot
  options: ["frontLever", "hangingLegRaise", "abWheel", "hardStyleSitup"],
  default: "frontLever",
}
```

Workouts become `{ ...meta, slots: [...] }`; the selected exercise per slot is
either a sensible default or a user choice persisted alongside the existing
session schema. Because everything keys on exercise `id`, history and CSV keep
working unchanged.

---

## 4. The balance engine (the interesting part)

### 4.1 Insight: balance is about *movement axes*, not muscle groups

The front-lever swap worked because we reasoned in climbing *qualities*, not
muscles: the core program covered **flexion** (hard-style situp) and
**anti-extension** (ab wheel) but had no **straight-arm tension** or
**compression**. That generalizes.

Tag each exercise with the **climbing quality / axis** it trains, more specific
than today's flat tags. For core:

- flexion
- anti-extension
- straight-arm body tension
- compression / active hip flexion
- rotation / anti-rotation

For power: vertical projection, horizontal projection, lateral plane,
rotational. For pulling: vertical, horizontal, lock-off, etc.

### 4.2 Taxonomy shape

Prefer a **structured** `{category: axis}` map over a flat tag list — it makes
coverage math clean and avoids overloading the existing recommender `tags`
(which stay as stimulus tags for `computeTagDaysSince`).

```js
// On each exercise, alongside `tags`:
climbingQualities: [
  { category: "core", axis: "straightArmTension" },
  { category: "core", axis: "antiExtension" },
],
```

### 4.3 What the engine does

Given the user's selected exercises (per session, week, or block), compute
**coverage**: which axes are trained, which are stacked redundantly, which are
missing. Then surface it gently:

- "Your selections cover 4 of 5 core qualities — missing **compression**."
- "Lots of vertical projection lately; no **lateral-plane** power in 3 weeks."

Crucially, the nudge should resolve to a **single suggested swap** that fills the
gap ("try hanging leg raise here"), not a wall of options.

### 4.4 Decision: per-session vs per-week vs per-block

Lean **per training block** (matching the frequency-not-dose worldview). A
single session doesn't need to be balanced; the *block* does. Per-session
nudging risks nagging and false alarms.

---

## 5. Rollout — ship the view before the recommender

Phasing chosen to match the app's "don't ship theoretical toggles" instinct:
prove usefulness with low-risk surfaces first.

**Phase 1 — Coverage view (read-only).** A "balance map" of which climbing
qualities you've trained over the last N weeks, powered by existing history +
`computeTagDaysSince`. No behavior change. This alone tells us whether the
fancier engine is worth building.

**Phase 2 — Per-slot swap menus.** Make slots real; let users swap within a slot.
Default-first (one tap unchanged); menu is progressive disclosure.

**Phase 3 — Active nudges.** The engine recommends the single swap that best
fills a coverage gap, opt-in, at the moment of choosing.

**Phase 4 — Climbing skills/drills library** (Section 7), reusing the same
coverage engine.

---

## 6. Key risk: choice paralysis kills adherence

The whole UX is built around "the easy yes" and one tap. A big menu cuts against
that. Mitigations, baked into the design:

- **Default-first, always.** Every slot has a sensible prescribed exercise; the
  menu is hidden until asked for.
- **The engine reduces decisions.** A nudge is "here's the one that fills your
  gap," never "here are eight options, you figure it out."
- **Balance is a block-level signal,** so it doesn't interrupt today's session.

---

## 7. The climbing skills & drills parallel

Same coverage model, different axes — and likely higher leverage, since skill
gaps cap grades more than strength does.

Candidate axes/dimensions for a drills library:

- **Movement patterns:** flagging, drop-knee, backstep, twist-lock, heel hook,
  toe hook, stemming, mantling.
- **Wall angle / conditions:** slab, vertical, overhang, roof.
- **Hold types:** crimp, sloper, pinch, pocket, jug.
- **Qualities:** precise footwork, static control, dynamic / coordination, body
  tension, mental / falling practice, route-reading / tactics.

A drill is tagged across these dimensions; the coverage engine surfaces blind
spots like "lots of steep crimp power, no slab or balance work in six weeks."
Logging can stay lightweight (a drill marker + optional note), mirroring how
`CLIMB` is already a loggable marker.

Likely new module: `src/model/climbingSkills.js`, parallel in shape to
`supportTraining.js`.

---

## 8. Open questions

1. **Taxonomy structure** — flat tags vs structured `{category, axis}` map.
   (Leaning structured.)
2. **Balance window** — per-session / per-week / per-block. (Leaning block.)
3. **Where selections live** — per-user persisted choices vs per-session
   snapshots; interaction with the existing `workout_sessions` schema and cloud
   mirror.
4. **How prescriptive defaults stay** — does the engine ever auto-rotate the
   default exercise to maintain balance, or only suggest?
5. **Skill logging fidelity** — marker-only vs structured (attempts, grade,
   angle) for drills.
6. **Migration** — slots must resolve historical sessions logged against
   fixed-list exercise ids (the kept-for-history pattern already in use).

---

## 9. Guiding principles (carry-over from the codebase)

- Frequency over dose.
- The user self-gates; don't build toggles for states they already manage.
- Ship the thing that does real data work; cut theoretical UI.
- Keep the happy path one tap — optionality is progressive disclosure.
- Exercise identity is by `id`; retire defs by keeping them for history, never
  deleting.
