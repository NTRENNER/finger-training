# Climbing Training Library — Balanced Physique + Skills & Drills

**Purpose:** A sourced, axis-mapped inventory of (1) strength/physique exercises and (2) climbing skills & drills, to seed the slot-based exercise library and balance engine described in `docs/design/exercise-library-and-balance-engine.md`.

**Scope:** Comprehensive / gym-agnostic equipment. Each entry notes the climbing **quality/axis** it trains, a key **cue**, and a **progression** (strength) or **how-to** (skills). The companion machine-readable file is `src/data/seeds/climbing-library-seed.js`.

---

## How to read this — the two organizing ideas

**1. Balance is about movement axes, not muscle groups.** Exercises are grouped by *function* (e.g. core: anti-extension vs compression vs rotation) so the balance engine can detect coverage gaps. The axis labels here map 1:1 to `climbingQualities: [{category, axis}]` in the seed.

**2. Two imbalances drive the "balanced physique" goal** (well supported in the literature and coaching):

- **Finger flexors ≫ finger extensors.** Climbers' finger-flexor force runs ~37% higher than non-climbers' while extensor capacity does not — nearly all climbing/finger work loads flexors. This lopsided ratio is implicated in finger and elbow tendinopathy, and is the rationale for the extensor/reverse-curl work below.
- **Pulling / internal rotation ≫ pressing / external rotation.** Climbing is almost entirely pulling, so lats and internal rotators dominate while rotator-cuff external rotators and scapular stabilizers lag — a leading driver of shoulder injury and climber's elbow. Hence the pressing, external-rotation, and scapular work.

> **Dosing rules of thumb from the sources:** antagonist/prehab work ~2–3×/week in short doses (often after climbing); train core qualities as low-rep *strength* (load it) rather than long flabby holds; keep power work low-rep and stop the moment speed drops.

---

# Part 1 — Strength & Physique (by movement axis)

## Pull — Vertical *(axis: pull/vertical)*

- **Pull-up (full range)** *(pull-up bar)* — base vertical pulling. Cue: keep shoulders engaged, don't fully dead-hang between reps. Progression: build ~15 clean reps before loading.
- **Weighted / hypergravity pull-up** *(belt/vest)* — max vertical pull. Cue: start +10–20 lb, drop weight at any shoulder/elbow tweak. Progression: 5×5, add load when all sets clean.
- **Lat pulldown** *(cable)* — scalable vertical pull below bodyweight. Cue: drive elbows toward the hips, chest tall. Progression: best entry before pull-ups; graduate to weighted pull-ups.
- **Chest-bump / explosive pull-up** *(bar)* — vertical pull + contact power. Cue: pull fast to chest, absorb the descent. Progression: only after base strength.

## Pull — Horizontal *(axis: pull/horizontal)*

- **Barbell / dumbbell bent-over row** *(barbell/DB)* — mid-back pulling balance to overhang pulls. Cue: flat back, elbow to hip, squeeze blades. Progression: load progressively; balances bench volume.
- **Inverted row** *(bar)* — scapular retraction, rhomboids/traps. Cue: straight body line, shoulders back-and-down. Progression: lower bar / elevate feet.
- **TRX / ring row** *(TRX/rings)* — horizontal pull + scapular control under instability. Cue: palms in, elbows straight back, body rigid. Progression: walk feet toward anchor; rings add instability.
- **Banded row** *(band)* — low-finger-stress horizontal pull. Cue: elbows back, squeeze blades, no shrug. Progression: stiffer band or single-arm (anti-rotation).

## Pull — Lock-off *(axis: pull/lockOff)*

- **90°/120° isometric lock-off holds** *(bar)* — static pull at reach angles. Cue: hold dead-still, no sag. Progression: add time, then weight; train your weak angle.
- **Frenchies** *(bar)* — lock-off endurance. Cue: per cycle lock 4s at top, 4s at 90°, 4s at 120°, no dead-hang. Progression: chain cycles/sets.
- **Typewriters** *(bar)* — lateral lock-off strength + endurance. Cue: shift weight under one arm, hold 3–5s, traverse. Progression: lower angle, more reps.

## Pull — One-arm progression *(axis: pull/oneArm)*

- **Uneven / offset-grip pull-up** *(bar + sling)* — one-arm builder. Cue: high hand loads, low hand only assists past its height. Progression: increase offset once 5–6 clean/side.
- **Archer pull-up** *(bar)* — one-arm progression. Cue: pull to one hand, other arm straight as a kickstand. Progression: move to offset-grip on the bar.
- **Band-assisted one-arm pull-up** *(bar + band)* — one-arm progression. Cue: thickest band that makes ~5 hard. Progression: thinner bands → 4×3 near max.
- **One-arm negatives** *(bar)* — one-arm eccentric. Cue: start at top lock-off, lower as slowly as possible. Progression: lengthen lower, reduce assist.

## Pull — Scapular control *(axis: pull/scapular — also shoulder prehab)*

- **Scapular pull-up / shrug hang** *(bar)* — loaded scapular control & shoulder health. Cue: from a dead hang, depress + retract blades, no elbow bend. Progression: two-arm → one-arm scapular shrugs.

## Press / Antagonist *(axis: press/horizontal, press/vertical, press/dips)*

> *Why:* restoring push/pull balance stabilizes the shoulder girdle, wards off climber's elbow/shoulder injury, and can even raise pulling numbers. Bench benchmarks (Bechtel): ~bodyweight (men), ~¾ bodyweight (women). Bench & shoulder press are the most direct pull-up antagonists; dips are tertiary.

- **Push-up (+ variations)** *(bodyweight)* — antagonist press, scapular control. Cue: elbows tucked, shoulders from ears, rigid core. Progression: weighted / decline / ring.
- **Bench press** *(barbell/DB)* — horizontal pressing balance. Cue: blades retracted and set, controlled bar path. Progression: load toward ~bodyweight.
- **Overhead / shoulder press** *(barbell/DB)* — vertical pressing + trap balance. Cue: brace, ribs down, straight bar path. Progression: DB → barbell.
- **Kettlebell press / overhead carry** *(kettlebell)* — shoulder stability under offset load. Cue: wrist stacked, core engaged. Progression: single-arm → bottoms-up.
- **Dips** *(parallel bars)* — triceps + chest (tertiary antagonist). Cue: shoulders down, don't sink too deep. Progression: after bench/OHP; add weight.
- **Banded press / push-up** *(band)* — resisted antagonist press. Cue: brace, full lockout, ribs down. Progression: more tension.

## Shoulder prehab *(axis: shoulderPrehab/externalRotation, /internalRotation, /scapular, /scaption)*

- **Band/cable external rotation** — external rotation; counters internal-rotation dominance. Cue: elbow pinned (towel), rotate from elbow. Progression: 15–20 light → add resistance.
- **Side-lying external rotation** *(DB)* — infraspinatus/teres minor. Cue: elbow tucked, rotate only at shoulder. Progression: stay light, fatigues fast.
- **Lying internal rotation** *(DB/band)* — internal rotation, for *balance* not bulk. Cue: slow, short range. Progression: ~20 light.
- **Reverse fly / prone T** *(DB)* — scapular retraction + rear delt. Cue: thumbs up, squeeze blades, no shrug. Progression: bent-over → prone → light DB.
- **Prone Y raise** *(DB)* — lower-trap / upward rotation. Cue: "Y," thumbs up, lift from blades. Progression: bodyweight → light plates.
- **Prone W raise** *(DB)* — retraction + external rotation. Cue: elbows down-and-back into "W." Progression: hold end range, add load.
- **Scaption** *(DB)* — supraspinatus / scapular-plane elevation. Cue: ~30° forward of side, thumbs up, stop at shoulder height. Progression: 15–20 light.
- **Face pull** *(cable/band)* — external rotation + retraction. Cue: pull to forehead, elbows high, finish externally rotated. Progression: raise anchor to bias cuff.
- **Band pull-apart** *(band)* — retraction / rear delt; daily filler. Cue: straight arms, lead with thumbs, no shrug. Progression: stiffer band / pause holds.

## Elbow & forearm health *(axis: elbowForearm/extensor, /flexor, /pronator, /fingerExtensor, /tendonHealth)*

- **Reverse wrist curl (wrist extension)** *(DB)* — extensor health; primary fix for flexor≫extensor & tennis elbow. Cue: palm-down, slow eccentric. Progression: light, 15–20, slow lower.
- **Reverse (pronated) arm curl** *(barbell/DB)* — brachioradialis / wrist-extensor loading. Cue: palms-down, control both phases. Progression: build load; pairs with reverse wrist curl.
- **Pronator (offset hammer) twist** *(hammer)* — pronator teres / **climber's elbow** (medial). Cue: forearm on thigh, rotate hammer up, lower over 5-count. Progression: eccentric-only → add concentric → longer lever.
- **Wrist flexor curl** *(DB)* — flexor health/balance (kept lighter). Cue: palm-up, controlled. Progression: don't outpace extensor work.
- **Finger-extensor band / rice bucket** *(rubber band / rice)* — finger-extensor strength. Cue: open fingers against band, or open/close in rice. Progression: thicker band / longer sets. *(Note: Hörst rates this less climbing-specific than the antagonist work above, but it's cheap and widely used.)*
- **Neutral-grip density lock-off hang** *(bar)* — tendon health / collagen remodeling. Cue: mid-range neutral hold 15–20s, dull (not sharp) discomfort. Progression: add reps → light load.

## Core — Anti-extension *(axis: core/antiExtension)*

- **Ab-wheel rollout** *(wheel)* — Cue: brace, posterior tilt, no sag. Progression: knees → standing.
- **Plank (hard brace)** *(bodyweight)* — Cue: short max-tension effort, glutes+abs, ribs down. Progression: banded → weighted.
- **TRX / ring fallout** *(TRX/rings)* — Cue: arms overhead, torso rigid, stop before arch. Progression: more horizontal.
- **Dead bug** *(bodyweight)* — Cue: low back flat, move opposite limbs slowly. Progression: add band/longer levers.

## Core — Anti-rotation *(axis: core/antiRotation)*

- **Pallof press** *(cable/band)* — Cue: press straight out, resist the twist, brace first. Progression: further from anchor / kneeling / hold.
- **Cable or band chop & lift** *(cable/band)* — anti-rotation through range. Cue: move diagonally, hips square. Progression: load / speed control.
- **Suitcase carry** *(DB/KB)* — anti-rotation + anti-lateral-flexion. Cue: one heavy load, walk tall, no lean. Progression: heavier / longer / march.
- **Bird-dog row** *(DB)* — anti-rotation under movement. Cue: row without twisting torso. Progression: slow eccentric, add load.

## Core — Flexion *(axis: core/flexion)*

- **Hanging leg raise** *(bar)* — flexion + grip. Cue: initiate by curling the pelvis, control the lower. Progression: knees → straight-leg → ankle weight.
- **Hard-style / RKC sit-up** *(band/bodyweight)* — flexion with full-body tension. Cue: drive heels, total tension, low reps. Progression: weighted.
- **Hollow-body rock** *(bodyweight)* — flexion + anterior tension. Cue: ribs down, low back glued. Progression: tuck → full → weighted.

## Core — Compression *(axis: core/compression)*

- **V-up** *(bodyweight)* — trunk + hip flexion together. Cue: reach to toes, straight legs, fold at hips. Progression: tuck → full → decline.
- **Toes-to-bar** *(bar)* — compression + grip; very climbing-specific. Cue: pull the bar toward the hips, no kip. Progression: knees-to-chest → toes-to-bar → strict.
- **Seated pike compression hold** *(bodyweight/box)* — lower-ab/hip-flexor specific. Cue: legs straight, actively lift heels and hold. Progression: floor → deficit box → ankle weight.
- **Candlestick → pike** *(bodyweight)* — compression + control. Cue: roll up, fold to tight pike, control phases. Progression: assisted → freestanding.

## Core — Rotation *(axis: core/rotation)*

- **Russian twist** *(med ball/plate)* — Cue: rotate from the trunk, chest tall, controlled. Progression: feet down → feet up → weighted.
- **Windshield wiper** *(bar/bodyweight)* — rotation + compression; advanced. Cue: legs together, shoulders stable, sweep side to side. Progression: bent-knee lying → straight-leg → hanging.
- **Landmine rotation** *(barbell)* — loaded standing rotation. Cue: drive from hips/core, arms fairly straight. Progression: half-kneeling → standing → add speed.

## Core — Full-body tension *(axis: core/fullBodyTension)*

- **Front lever** *(bar/rings)* — gold-standard climbing core. Cue: straight arms "push bar down," posterior tilt, squeeze glutes/legs. Progression: tuck → adv tuck → single-leg/straddle → full.
- **Dragon flag** *(bench)* — tension + anti-extension. Cue: pivot from upper back, body rigid as a rod, lower slow. Progression: tuck → straddle → full.
- **Hollow-body hold** *(bodyweight)* — foundational tension (teaches flagging/straight-arm bracing). Cue: ribs down, low back flat, limbs squeezing. Progression: tuck → full → add time/weight.
- **L-sit** *(floor/parallettes)* — tension + compression. Cue: depress shoulders, lock knees, lift to horizontal. Progression: foot-supported → tuck → full → V-sit.
- **Tension-board / steep-wall body-tension drill** *(wall)* — sport-specific transfer. Cue: drive toes in, brace trunk so hips don't sag. Progression: bigger → smaller feet, steeper.

## Lower — Hinge *(axis: lower/hinge)*

- **Conventional deadlift** *(barbell)* — posterior chain + whole-body tension; top off-wall lift. Cue: hips above knees, brace hard. Progression: light technique → heavy 3–5s.
- **Romanian deadlift (RDL)** *(barbell/DB)* — hamstring/glute hinge at length. Cue: hips back, soft knee, stop before back rounds. Progression: load → single-leg.
- **Kettlebell swing** *(kettlebell)* — explosive hip extension / RFD. Cue: snap hips, bell floats, no squat/arm-lift. Progression: two-hand → one-hand → heavier.
- **Hip thrust / glute bridge** *(barbell/bodyweight)* — glute strength + posterior tension for high feet/steeps. Cue: drive heels, hard glute squeeze, ribs down. Progression: bodyweight → barbell → single-leg.
- **Back extension / reverse hyper** *(bench/machine)* — spinal-erector & glute endurance (neglected posterior core). Cue: lift to neutral, don't hyperextend. Progression: add load / pause.

## Lower — Squat & unilateral *(axis: lower/bilateral, /unilateral, /lateral)*

- **Goblet / back squat** *(KB/barbell)* — bilateral leg drive. Cue: knees over toes, brace, controlled depth. Progression: goblet → barbell.
- **Rear-foot-elevated split squat** *(DB/barbell)* — unilateral leg strength; mimics one-leg drive / drop-knee. Cue: front shin loaded, torso tall. Progression: load → bottom pause.
- **Step-up (high box)** *(box + DB)* — single-leg push for high-stepping/mantling. Cue: drive only through top leg. Progression: raise box, add load.
- **Cossack squat** *(bodyweight/KB)* — lateral strength + adductor mobility for wide stems/drop-knees. Cue: sit over bent leg, other straight, heels down. Progression: supported → unsupported → weighted.
- **High-step on box with TRX** *(box + TRX)* — strength through end-range hip flexion (the high-foot limiter). Cue: step on toes while pulling arms; less pull = harder. Progression: raise box / reduce assist.

## Hamstring (heel-hook generation) *(axis: hamstring/eccentric, /kneeFlexion)*

- **Nordic hamstring curl** *(bodyweight/partner)* — eccentric knee-flexor strength; ~50% hamstring-injury reduction in reviews. Cue: lower as slowly as possible. Progression: assisted/short range → full range over 6–10 wks.
- **TRX / Swiss-ball leg curl** *(TRX/ball)* — hamstring/glute + hip-extension control for heel-hook pull. Cue: hips lifted in a bridge throughout. Progression: two-leg → single-leg.
- **Single-leg RDL** *(DB/KB)* — unilateral hamstring/glute + balance (mirrors loading one heel hook). Cue: hinge over stance leg, hips square. Progression: add load/range.

## Hip mobility & end-range strength *(axis: hipMobility/flexion, /rotation, /adduction, /endRangeStrength)*

- **Hip CARs** *(bodyweight)* — active end-range control for drop-knees/feet-to-wall. Cue: march → open → drop-knee → extend, pelvis neutral. Progression: widen circle.
- **Frog stretch** *(bodyweight)* — adductor/hip-flexion range ("frogger," hips close). Cue: shins parallel, rock hips back. Progression: toward pelvis-to-floor.
- **Pancake / seated straddle** *(bodyweight)* — adductor + hamstring length for wide stems/high lateral feet. Cue: hinge from hips, long spine. Progression: active reaches / loaded end-range.
- **90/90 (+ heel lift)** *(bodyweight)* — internal/external hip rotation + end-range strength for drop-knees. Cue: off the tailbone; back knee down, lift heel. Progression: passive → active heel lifts → transitions.
- **Deep squat (active sit)** *(bodyweight/KB)* — ankle/hip range for staying compact under high feet. Cue: heels down, chest up, pry knees out. Progression: add load/time.
- **Cossack / eccentric adductor** *(bodyweight/cable)* — groin mobility + strength to use it (stem injury prevention). Cue: shift in/out over a step; resist as adductor lengthens. Progression: add resistance/range.

## Power / explosive *(axis: power/verticalProjection, /horizontalProjection, /lateralPlane, /rotational, /contactStrength, /fingerRFD)*

> *Why:* powerful climbing is governed by rate of force development; off-wall power spares fingers, then transfers to deadpoints/dynos. Keep reps low, stop when speed drops.

- **Broad jump** *(bodyweight)* — horizontal projection. Cue: arm swing, explode through hips, land soft. Progression: distance / consecutive.
- **Vertical / box jump** *(bodyweight/box)* — vertical projection (full dynos). Cue: arm swing, light quiet two-foot landing; step down. Progression: raise target; 3×3–5.
- **Jump lunge** *(bodyweight)* — unilateral projection (one-leg drive). Cue: explode, switch mid-air, max air time. Progression: 3×5–10/leg.
- **Skater jump / bound** *(bodyweight)* — lateral plane (side-to-side moves). Cue: push laterally for distance, land one foot, use arms. Progression: 3×5–10/side, more distance.
- **Med-ball slam** *(med ball)* — full-chain power (absorb→reverse). Cue: reach tall, drive down whole-body. Progression: heavier / add jump.
- **Med-ball rotational/overhead throw** *(med ball)* — rotational power → upper-body contact strength. Cue: sequence hips→trunk→arms. Progression: heavier / longer throw.
- **Kettlebell snatch** *(kettlebell)* — triple-extension hip power. Cue: one smooth pull, punch hand through at top. Progression: load for output.
- **Power pull-up** *(bar)* — upper-body contact strength (closest off-wall match, spares fingers). Cue: pause 1s at bottom so each rep is its own explosion. Progression: 3×3–5; chest-to-bar / light weight.
- **Power / clap push-up** *(bodyweight)* — explosive press for mantles/compression. Cue: push the ground away hard, air time. Progression: 3×3–5; elevate / weight.
- **Plyo mountain climbers** *(bodyweight)* — hip-flexor/quad power for snapping a foot to a high toehold. Cue: drive knee off the ball of the foot, hips level. Progression: 3×10–20/leg, faster.
- **Campus board — ADVANCED, CAUTION** *(campus board)* — finger RFD / contact strength. Cue: precise + explosive but well within finger tolerance; never fatigued. **Caution:** injury-free advanced fingers only; closed-crimp loading risks pulley damage and PIP growth-plate injury in youth; short blocks, full recovery.

## Band-specific (cross-reference) *(equipment: band)*

Pull-aparts, band "T," band reaches, wall angels, shoulder dislocates, monster/lateral walks (glute-med/hip stability), banded row, banded press/push-up, banded external rotation, banded Pallof. *(Details under their axis sections above; tagged `band` in the seed.)*

## TRX / suspension (cross-reference) *(equipment: trx)*

Row, single-arm row, fallout/body-saw (anti-extension), pike (compression), atomic push-up (press + tuck), hamstring curl, Y/T/W deltoid series (scapular/posterior shoulder), mountain climber, overhead squat, side plank w/ hip raise, clock press, T-spine rotation. A climbing-specific TRX circuit (Fraser Quelch for Climbing.com) is done ~2×/week on rest days, up to 3 sets each. *(Tagged `trx` in the seed.)*

---

# Part 2 — Climbing Skills, Techniques & Drills

## Footwork *(dimension: footwork)*

- **Precise / silent placement** — efficiency, trust. Place the toe deliberately and silently, then weight it (no readjust).
- **Edging — inside edge** — workhorse on small face holds. Stiff ankle, stand on the spot under the big toe.
- **Edging — outside edge** — enables backsteps/twists. Stand on the outside corner under the little toe, ankle rigid.
- **Smearing** — friction with no defined hold (slab). Max rubber on wall, drop the heel, weight over the foot.
- **Foot swap** — set up the next move. Hop-swap or roll the toe off while sliding the other on precisely.
- **Backstepping (foot)** — bring a hip to the wall, save arms. Stand on the outside edge of the trailing foot, drop that knee.
- **Toeing-in** — precision on tiny edges/pockets. Point the toe into the hold so the big toe loads it.
- **Heel-down vs heel-up** — friction (down) vs reach/leverage (up). Drop heel for smear; raise it to extend/push.

## Body positioning *(dimension: bodyPositioning)*

- **Inside flag** — prevents barn-door when reaching. Swing the free foot across in front of the stance.
- **Outside flag** — most common balance flag. Press the flagging foot out to the side, low and weighted.
- **Back flag** — stabilize on steep ground. Tuck the trailing foot behind and smear it.
- **Drop-knee (Egyptian)** — pulls hips in, adds reach on steep, cuts arm load. Stand wide, point a toe and drop that knee inward, twist hip in.
- **Twist-lock / hip turn** — straight reaching arm gains length. Pivot the reaching-side hip into the wall and lock.
- **Straight-arm "skeleton" hang** — rest on bones, not biceps. Keep arms extended whenever not actively moving.
- **Hips close to the wall** — weight onto feet, light grip. Push the pelvis toward the rock.
- **Center of gravity over feet** — max friction, less hand load. Stack the torso so weight drives through the standing foot.

## Movement skills *(dimension: movement)*

- **Static movement** — precise, reversible. Move slowly with weight set over feet.
- **Dynamic movement** — momentum instead of pure strength. Drive from the legs, catch as motion peaks.
- **Lock-off** — hold still to free a hand. Pull holding arm to ~90°, engage back, reach.
- **Deadpoint** — catch at the weightless apex. Latch exactly when upward velocity hits zero.
- **Dyno (single)** — all-out jump to a far hold. Pump legs/hips, launch, latch at the top.
- **Double dyno** — both hands leave and catch together. Coil low, explode, stick both with body tension.
- **Coordination / parkour moves** — linked momentum on steep/comp terrain. Chain swings/jumps/catches in rhythm.
- **Momentum & pendulum** — swing to reposition/reach. Initiate from feet/hips, time the catch.
- **Mantling** — press onto a ledge with nothing above. Push down on the palm, foot up high, rock over and stand.
- **Rock-over / high step** — step high, shift weight, stand. Foot high, hips forward over it, stand with the leg.
- **Downclimbing** — descend/retreat; sharpens footwork. Look for feet, arms straight, lower onto chosen holds.

## Specific techniques *(dimension: technique)*

- **Heel hook** — third "hand"; steep/overhang. Set heel, pull with the hamstring to draw in.
- **Toe hook** — resist swing on roofs/underclings. Hook the top of the toes, pull with shin/foot.
- **Knee bar** — hands-free rest/lock. Toe into one hold, jam knee/thigh against an opposing feature.
- **Knee scum** — extra friction/stability. Smear the inside knee/thigh on the wall.
- **Stemming / bridging** — opposing pressure in corners; restful. Press hands/feet outward on opposing walls.
- **Gaston** — outward push on an inward-facing hold. Elbow out, push away ("pry the doors open").
- **Undercling** — pull up on a downward-facing hold, hips in. Palm-up, pull out-and-up, walk feet high.
- **Side pull** — lateral pull on a sideways hold. Grip the edge, lean away to oppose.
- **Layback (lieback)** — opposing pull/push on an edge/arête. Pull with hands, push feet on the opposite surface.
- **Palming** — hand smear. Press a flat palm where there's no hold.

## Grip types *(dimension: grip)*

- **Full crimp** — max power on tiny edges; highest strain. Thumb over index nail; reserve for hardest moves.
- **Half crimp** — strong, versatile everyday hard-pull grip. First knuckles ~90°, thumb off.
- **Open hand / drag** — lowest strain; slopers/rounded/pockets. Fingers relaxed and extended.
- **Sloper technique** — friction-dependent; body position over grip. Flat open hand, max skin, hips in/low.
- **Pinch** — squeeze between fingers and thumb. Actively oppose thumb and fingers.
- **Pocket** — 1–3 finger holes. Middle+ring for two-finger; open-hand to protect tendons.
- **When to use each** — default open-hand to save tendons → half-crimp to pull hard → full-crimp only when nothing else holds.

## Crack *(dimension: crack)*

- **Finger jam** — narrow cracks. Slot fingers thumb-down, rotate elbow down to cam.
- **Hand jam** — most secure; hand-width. Insert flat, cup/expand by clenching.
- **Fist jam** — fist-width; less secure. Insert fist, clench to expand.
- **Offwidth** — too wide for fists. Stack hands/fists, arm bars, chicken wings, leg/heel-toe cams.
- **Stemming in corners** — bridge opposing dihedral walls. Push outward with feet (and hands).

## Angles & styles *(dimension: angle)*

- **Slab / balance** — balance & footwork over strength. Heels low for smear, weight over feet, trust subtle placements.
- **Vertical / face** — efficient positioning. Manage CoG, straight arms, turn hips to reach.
- **Overhang / steep** — core tension to keep body close. Engage core + toes/heels, climb with momentum, rest straight-armed.
- **Roofs** — most tension-dependent. Toe hooks, heel hooks, full-body tension to move through.

## Technique drills *(dimension: drill)*

- **Silent / quiet feet** — precision/awareness. Climb easy terrain placing each foot noiselessly; a "click" = redo from the last hold.
- **Coin holds** — exact placement. Set coins on footholds; knocking one off = restart.
- **Sticky / glue feet (one-touch)** — first-try accuracy & economy. Once a foot touches, no lift/shuffle (pivot OK); re-adjust sends it back.
- **3-second hover** — deliberate placement. Hover the toe over the target ~3s, then place precisely.
- **Foothold stare** — visual tracking. Watch the foothold as you place, keep watching 3s more.
- **Hover hands / dead stops** — deceleration, body tension, static control. Pause and hold a static position at the end of each move; or hover the hand before placing.
- **Straight-arm only** — efficient hanging. Bend the arm only to actually pull a move.
- **Tracking (feet follow hands)** — intentional foot sequencing. Place each foot only where a hand just was.
- **Downclimbing drill** — footwork + reverse route reading + economy. Climb back down on the same holds.
- **Eliminates (bad/restricted holds)** — creative movement & positioning. Re-climb with key good holds off-limits.
- **Sloth / monkey** — control vs rhythm. Climb as slow-and-continuous as possible; then fast-and-fluid.
- **Pace drill** — conscious speed control. Assign sections target speeds and execute (fast cruxes, slow rests).
- **Tennis-ball hands / no-hands slab** — balance, hips, footwork. Only touch tennis balls to the wall; progress to hands-free slab.
- **Perfect / refined repeat** — ingrain efficient patterns. Re-climb a known problem executing every move as cleanly/quietly as possible.
- **Experiment & vary (MacLeod)** — adaptable body awareness. Treat each climb as a chance to try new solutions over a huge variety of styles/angles/rock; breadth of mileage beats rote drilling.

## Volume & energy-system *(dimension: energySystem)*

- **ARC training** — aerobic capacity/capillarity + technique under mild fatigue. 30–60 min continuous, ~3–4 grades below limit, light never-occluding pump.
- **Aerobic mileage / volume** — endurance base, efficiency, recovery. Accumulate easy-to-moderate climbing (bigger base → better rests).
- **4x4s** — anaerobic/power-endurance. 4 problems back-to-back, rest 3–4 min, ×4 rounds; deliberate pump.
- **Circuits / linked problems** — power-endurance & pacing over sequences. Link many moves into continuous laps.
- **Limit bouldering** — max recruitment/power & hard movement. 1–3 hardest moves, full rest; focus on the limit move, not topping.
- **Repeaters (climbing-style)** — power-endurance via work:rest intervals. Short on-wall bouts with brief rests.
- **Density training** — work capacity. More climbing in a fixed block, increase density over time.
- **Projecting vs mileage (choice)** — peak performance/skill vs base/technique/recovery. Choose deliberately; they train different things.

## Tactics *(dimension: tactics)*

- **Route reading / sequencing** — decode moves before leaving the ground (boosts onsight). Map hands/feet/positions/clips/rests from the floor.
- **Previsualization / mental rehearsal** — stored motor plan, less hesitation. "Run the movie" of smooth execution incl. breathing/clips.
- **Redpoint tactics** — dial & link a hard route. Work sections, memorize beta/rests, link growing pieces to a clean send.
- **Onsight tactics** — first-go on unknown terrain. Read thoroughly, climb decisively, find rests, clip from stable stances, keep moving.
- **Resting & shaking out** — mid-route recovery & pump management. Use rest positions; alternate shaking each forearm low; breathe.
- **Clipping practice** — fast, secure clips from stable stances. Practice from good rests; plan clip positions while reading.
- **Pacing** — energy distribution across a route. Rehearse where to accelerate vs recover.

## Mental *(dimension: mental)*

- **Fall practice (incremental)** — desensitize fear of falling. Stage it: short TR → long TR → lead from top bolt → advanced; increment only while relaxed.
- **Falling technique / soft catch** — safe, relaxed impact. Stay loose, breathe, meet the wall soft; belayer gives a dynamic catch.
- **Fear-of-falling management** — reframe fear as a distractor. Treat falls as learning; staged exposure frees attention.
- **Commitment** — decisive execution past retreat. Practice committing in safe settings; train out hesitation via graded consequence.
- **Visualization / imagery (Hörst)** — motor learning, focus, readiness. Use first- and third-person imagery to pre-program sends.
- **Arousal regulation** — control activation (calm down / psych up). Breathwork, mindfulness, routines to hit the optimal zone.
- **Focus / pre-climb routine (Hörst)** — consistent concentration. A repeatable sequence (breath, cue word, quick visualization, tie-in ritual) before every burn.

---

## Coverage check (axes → at least one entry)

Strength: pull {vertical, horizontal, lockOff, oneArm, scapular} · press {horizontal, vertical, dips} · shoulderPrehab {externalRotation, internalRotation, scapular, scaption} · elbowForearm {extensor, flexor, pronator, fingerExtensor, tendonHealth} · core {antiExtension, antiRotation, flexion, compression, rotation, fullBodyTension} · lower {hinge, bilateral, unilateral, lateral} · hamstring {eccentric, kneeFlexion} · hipMobility {flexion, rotation, adduction, endRangeStrength} · power {verticalProjection, horizontalProjection, lateralPlane, rotational, contactStrength, fingerRFD}. **All covered.**

Skills: footwork · bodyPositioning · movement · technique · grip · crack · angle · drill · energySystem · tactics · mental. **All covered.**

---

## Sources

Synthesized from reputable climbing-training and sport-science sources gathered across this research. Primary/most-used:

**Strength & physique**
- Eric Hörst / Training for Climbing — pull-up variations, scapular pull-up, rotator-cuff routine, climber's-elbow (medial) protocol, forearm antagonist training, plyometrics, posterior chain: trainingforclimbing.com
- Climbing.com — antagonist workouts; climber-specific TRX circuit (Fraser Quelch); sport core: climbing.com/skills
- Lattice Training — antagonist priorities, training power (P=F×v, RFD): latticetraining.com/blog
- Power Company Climbing / Steve Bechtel — antagonist benchmarks, deadlifting/hinge: powercompanyclimbing.com; Climb Strong
- Hooper's Beta — one-arm pull-up progressions, deadlift/bench (w/ Lattice), FDP strain: hoopersbeta.com/library
- The Climbing Doctor — 360° core, hip mobility, antagonist band work: theclimbingdoctor.com
- TrainingBeta — uneven-grip & hypergravity pull-ups, Climb Strong core, epicondylitis: trainingbeta.com
- Peer-reviewed: flexor/extensor imbalance (NCBI PMC10701375); Nordic hamstring curl injury reduction (Wikipedia/NCBI PMC12572617)
- Campus board cautions: Anderson brothers (Rock Climber's Training Manual); mojagear campus guide; camp4humanperformance youth-training

**Skills, techniques & drills**
- Dave MacLeod — 9 Out of 10 Climbers Make the Same Mistakes (footwork, experiment/vary): davemacleod.com; gripped.com
- REI, VDiff Climbing, Climbing.com, Send Edition, Phila Rock Gym, Movement Gyms — technique guides (footwork, body position, dynamic, crack, holds)
- 99Boulders — footwork-drill compilation (silent/sticky/coin/foothold-stare/downclimb/traverse/tennis-ball/no-hands/toe-stab)
- Power Company Climbing (Kris Hampton) — movement drills (dead stops, 3-sec hover, sloth/monkey, one-touch, pace, heavy feet); limit bouldering
- Lattice Training — energy systems (ARC, aerobic vs anaerobic, repeaters)
- Eric Hörst / Maximum Climbing — visualization, focus routines, mental strategies
- Arno Ilgner / The Rock Warrior's Way — fall practice, fear management (alpinist.com feature)

*Note: this is a practitioner's synthesis for library-seeding, not a claim-by-claim citation map. A few items (some Bechtel/Lattice/MacLeod specifics) were drawn from search summaries and overview pages rather than deep article fetches; verify exact protocols against the primary source before publishing any as prescriptive.*
