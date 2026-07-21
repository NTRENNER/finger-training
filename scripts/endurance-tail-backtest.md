# Endurance-tail ceiling — backtest

`prescription()` builds a load as `curve_shape(T) × amplitude_anchor`, where the
three-exp `curve_shape` has no non-zero asymptote and the amplitude anchor is
the single most-recent rep 1 at ANY duration. When that recent rep is a short,
strong effort, its amplitude rescales the whole curve up — including the long
endurance tail. On 2026-07-20 this prescribed ~10 kg for a 160 s Micro hold
(genuine sustainable ~7 kg); the hold failed at 46 s.

Two fixes shipped for that session. The **capacity-floor fix** (PR #40) stopped a
spring/manual entry from pinning the floor. This change adds a **long-duration
ceiling** for the remaining, anchor-driven inflation.

## What to bound the long tail with

Forward-chained holdout over the real rep-1 history: for each measured fresh
failure at (T = actual_time_s, F), fit on prior-only data and predict F.
Long subset = T ≥ 140 s (the strength-endurance + endurance zones). Relative
abs error `|pred − F| / F`.

| model (long holds, n=16) | median | mean |
|---|---|---|
| current engine (three-exp × anchor) | 0.326 | 1.227 |
| critical force `CF + W′/T` (properly fit) | 0.239 | 0.614 |
| **power law `a·T^−b`** | **0.239** | **0.504** |
| robust multi-session global anchor | 0.396 | 0.748 |

The **power law wins**; the critical-force hyperbola (the classic Monod model
the app migrated off in March 2026) fits the sparse long end badly and is
unstable. A robust multi-session anchor cut the tail too, but it reshapes every
zone's amplitude and so degraded the all-zone median (0.133 → 0.187) — it pays
for tail robustness with typical-case accuracy everywhere.

## Why a ceiling, not a replacement

Applying the power law only as a **ceiling** — `value = min(engineValue,
tail(T) × margin)` — is surgical. It engages only when the engine is above the
endurance tail, i.e. exactly the inflation cases, and never touches short/mid
targets. Backtest of the shipped mechanism (fit T ≥ 30, exponent shrunk toward
0.45, threshold 140 s):

| long holds (n=16) | median | mean | mid-zone (90–140 s) engagements |
|---|---|---|---|
| engine | 0.337 | 1.227 | — |
| engine + ceiling (margin 1.10) | 0.329 | 0.769 | **0** |

The all-zone median stays **0.133** (unchanged) because the ceiling never fires
below 140 s. On the 2026-07-20 session it brings Micro 160 s from ~10.3 → **7.8**
(R) and ~7.8 → **7.4** (L), both at the genuine ~6–7 kg capacity.

## Design

- Fit `F = a·T^−b` on MEASURED fresh failures with T ≥ 30 s (short max efforts
  follow a different mechanism and steepen the slope); exponent ridge-shrunk
  toward a population prior (0.45) so sparse grips can't produce a wild slope.
- Ceiling = `tail(T) × 1.10` (10 % progression headroom) for T ≥ 140 s.
- The demonstrated-capacity floor still overrides it (a hold you actually
  sustained beats the model), and it's gated to within `EXTRAP_FLOOR_MULT` of
  the longest logged hold so it never fights the anti-collapse floor past the
  data range.

Reproduce: `src/model/__tests__/enduranceTail.backtest.test.js` (self-skips in
CI; set `ENDURANCE_BACKTEST_JSON`).
