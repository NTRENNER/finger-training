// ─────────────────────────────────────────────────────────────
// BADGES / JOURNEY VIEW
// ─────────────────────────────────────────────────────────────
// Renders the "Journey" tab — gamified per-grip progression based
// on three-exp curve AUC growth above each grip's baseline fit.
//
// Design notes:
//   * Per-grip journey. Micro and Crusher each earn Genesis
//     independently (one session in each zone for that grip), then
//     progress through the badge ladder based on their own AUC growth
//     above their own grip-baseline fit. Mirrors how the rest of the
//     app went per-grip after the early "pooled all grips" experiment.
//   * Three-exp model. Previously used Monod CF/W' AUC, which is the
//     demoted "second opinion" model. Switched to the canonical three-
//     exp basis so the Journey speaks the same language as the F-D
//     chart, Curve Improvement card, Coaching prescription, etc.
//   * Open-ended ladder. Old version capped at +100% (Realization)
//     leaving serious lifters with nothing to chase. Extended to 12
//     tiers with thresholds growing roughly geometrically; we can add
//     more later by appending to BADGE_CONFIG without breaking saved
//     state (no badge state is persisted; everything is derived).
//
// Pure read-only view — no mutations, no localStorage. State comes in
// via props: history (for zone coverage + per-grip rep filtering) and
// threeExpPriors (the per-grip prior used by fitThreeExpAmps).

import React, { useMemo } from "react";
import { C } from "../ui/theme.js";
import { zoneOf } from "../model/zones.js";
import { fitThreeExpAmps, computeAUCThreeExp } from "../model/threeExp.js";

// 12-stage badge ladder. Threshold = % AUC growth above the per-grip
// baseline. Genesis is the lone non-AUC unlock (zone coverage only).
//
// Threshold sequence: 0, 10, 22, 37, 55, 75, 100, 135, 175, 220, 275, 340.
// Roughly geometric growth so each rank takes a similar % MORE work
// than the previous, even as gains slow at the top end.
export const BADGE_CONFIG = [
  { id: "genesis",     label: "Genesis",     emoji: "🌱", threshold: 0,   desc: "One session in every zone for this grip — the curve awakens" },
  { id: "foundation",  label: "Foundation",  emoji: "🏛️", threshold: 10,  desc: "10% above baseline — the base is taking shape" },
  { id: "progression", label: "Progression", emoji: "📈", threshold: 22,  desc: "22% above — the model sees real upward movement" },
  { id: "momentum",    label: "Momentum",    emoji: "⚡", threshold: 37,  desc: "37% above — adaptation is compounding" },
  { id: "forge",       label: "Forge",       emoji: "🔨", threshold: 55,  desc: "55% above — past the easy gains, building through volume" },
  { id: "threshold",   label: "Threshold",   emoji: "🔥", threshold: 75,  desc: "75% above — crossing into rare territory" },
  { id: "realization", label: "Realization", emoji: "🏔️", threshold: 100, desc: "2× your baseline capacity — the potential fulfilled" },
  { id: "mastery",     label: "Mastery",     emoji: "🎯", threshold: 135, desc: "135% above — you've internalized what works" },
  { id: "ascendance",  label: "Ascendance",  emoji: "🪽", threshold: 175, desc: "175% above — beyond what most ever reach" },
  { id: "apex",        label: "Apex",        emoji: "👑", threshold: 220, desc: "220% above — you're at the top of your training arc" },
  { id: "mythic",      label: "Mythic",      emoji: "🌟", threshold: 275, desc: "275% above — territory only the obsessed visit" },
  { id: "legendary",   label: "Legendary",   emoji: "🏆", threshold: 340, desc: "340% above — your name is in the data" },
];

// Per-grip three-exp fit + baseline + current AUC, mirroring the same
// logic AnalysisView uses for Curve Improvement (single source of
// truth would be a model-layer helper; left inline here for now to
// keep the view self-contained).
//
// fitAmps: identical pattern to AnalysisView.fitAmpsForPts — pulls
// the grip prior, applies adaptive lambda based on point count.
const THREE_EXP_LAMBDA_DEFAULT = 0.5;
function fitAmps(pts, grip, threeExpPriors) {
  if (!pts || pts.length < 1) return null;
  const prior = (grip && threeExpPriors && threeExpPriors.get)
    ? (threeExpPriors.get(grip) ?? [0, 0, 0])
    : [0, 0, 0];
  const hasPrior = (prior[0] + prior[1] + prior[2]) > 0;
  const lambda = hasPrior ? THREE_EXP_LAMBDA_DEFAULT / Math.max(pts.length, 1) : 0;
  const amps = fitThreeExpAmps(pts, { prior, lambda });
  if (!amps || (amps[0] + amps[1] + amps[2]) <= 0) return null;
  return amps;
}

// Baseline fit: earliest window of failures for this grip that
// satisfies ≥5 reps across ≥3 distinct durations. Returns the date
// of the seed window's first rep (used as the "since" label).
function gripBaselineFit(history, grip, threeExpPriors) {
  const reps = (history || [])
    .filter(r => r.failed && r.grip === grip)
    .filter(r => r.avg_force_kg > 0 && r.avg_force_kg < 500 && r.actual_time_s > 0)
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const acc = [];
  const durs = new Set();
  for (const r of reps) {
    acc.push(r);
    durs.add(r.target_duration);
    if (acc.length >= 5 && durs.size >= 3) {
      const amps = fitAmps(
        acc.map(x => ({ T: x.actual_time_s, F: x.avg_force_kg })),
        grip,
        threeExpPriors
      );
      if (amps) return { date: acc[0].date, amps };
      return null;
    }
  }
  return null;
}

// Current fit: all failures for this grip.
function gripCurrentFit(history, grip, threeExpPriors) {
  const pts = (history || [])
    .filter(r => r.failed && r.grip === grip)
    .filter(r => r.avg_force_kg > 0 && r.avg_force_kg < 500 && r.actual_time_s > 0)
    .map(r => ({ T: r.actual_time_s, F: r.avg_force_kg }));
  return fitAmps(pts, grip, threeExpPriors);
}

// Pure presentational chunk for one grip's journey. Repeated stacked
// for each grip the user has trained.
function GripJourney({ grip, history, threeExpPriors }) {
  // Zone coverage for this grip's Genesis. A rep counts toward a
  // zone via target_duration → zoneOf, the same bucketing used
  // everywhere else. Failed/successful both count — the goal is
  // "show up in this zone," not "fail in it."
  const gripReps = useMemo(
    () => (history || []).filter(r => r.grip === grip),
    [history, grip]
  );
  const hasPower    = gripReps.some(r => zoneOf(r.target_duration) === "power");
  const hasStrength = gripReps.some(r => zoneOf(r.target_duration) === "strength");
  const hasCapacity = gripReps.some(r => zoneOf(r.target_duration) === "endurance");
  const genesisEarned = hasPower && hasStrength && hasCapacity;

  // Per-grip three-exp AUC (current + baseline). Both can be null if
  // the grip doesn't have enough failure data for a baseline window
  // yet — in that case the Journey shows "still seeding the model."
  const baseline = useMemo(
    () => gripBaselineFit(history, grip, threeExpPriors),
    [history, grip, threeExpPriors]
  );
  const current = useMemo(
    () => gripCurrentFit(history, grip, threeExpPriors),
    [history, grip, threeExpPriors]
  );
  const baselineAUC = baseline ? computeAUCThreeExp(baseline.amps) : null;
  const currentAUC  = current  ? computeAUCThreeExp(current)        : null;
  const pctImprove  = (baselineAUC && currentAUC && currentAUC > 0 && baselineAUC > 0)
    ? Math.max(0, (currentAUC - baselineAUC) / baselineAUC * 100)
    : 0;

  // Earned set: Genesis lone unlock is by zone coverage; everything
  // else requires Genesis + AUC threshold.
  const earnedIds = new Set(
    BADGE_CONFIG
      .filter((b, i) => i === 0 ? genesisEarned : genesisEarned && pctImprove >= b.threshold)
      .map(b => b.id)
  );
  const earnedList   = BADGE_CONFIG.filter(b => earnedIds.has(b.id));
  const currentBadge = earnedList[earnedList.length - 1] ?? null;
  const nextBadge    = BADGE_CONFIG.find(b => !earnedIds.has(b.id)) ?? null;

  const prevThr = currentBadge?.threshold ?? 0;
  const nextThr = nextBadge?.threshold ?? prevThr;
  const toNext  = nextBadge && nextThr > prevThr
    ? Math.min(100, Math.max(0, (pctImprove - prevThr) / (nextThr - prevThr) * 100))
    : 100;

  const zonesHave = [hasPower, hasStrength, hasCapacity].filter(Boolean).length;

  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`,
      borderRadius: 12, padding: 16, marginBottom: 18,
    }}>
      {/* Grip header + current badge hero */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
        <div style={{ fontSize: 44, lineHeight: 1 }}>{currentBadge?.emoji ?? "⬜"}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: C.muted, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            {grip}
          </div>
          <div style={{ fontSize: 20, fontWeight: 800, color: C.text, marginTop: 2 }}>
            {currentBadge?.label ?? "Begin your journey"}
          </div>
          {genesisEarned && baselineAUC != null && (
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
              +{pctImprove.toFixed(1)}% AUC since {baseline.date}
            </div>
          )}
        </div>
      </div>

      {/* Genesis checklist — shown only until earned for this grip */}
      {!genesisEarned && (
        <div style={{ background: C.bg, borderRadius: 10, padding: "12px 14px", marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 4 }}>
            Earn {grip} Genesis 🌱
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
            Log one {grip} session in each training zone to seed your curve.
          </div>
          {[
            { label: "Power — 7s hang",     done: hasPower },
            { label: "Strength — 45s hang", done: hasStrength },
            { label: "Endurance — 120s+",   done: hasCapacity },
          ].map(z => (
            <div key={z.label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 15 }}>{z.done ? "✅" : "⬜"}</span>
              <span style={{ fontSize: 12, color: z.done ? C.green : C.muted, fontWeight: z.done ? 600 : 400 }}>
                {z.label}
              </span>
            </div>
          ))}
          <div style={{ height: 4, background: C.border, borderRadius: 2, marginTop: 8 }}>
            <div style={{
              height: "100%", borderRadius: 2, background: C.green,
              width: `${(zonesHave / 3) * 100}%`, transition: "width 0.4s",
            }} />
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{zonesHave} of 3 zones covered</div>
        </div>
      )}

      {/* No-baseline state — Genesis earned but not enough failures
          to seed the F-D fit yet (need ≥5 failures across ≥3 distinct
          durations on this grip). */}
      {genesisEarned && !baseline && (
        <div style={{
          background: C.bg, border: `1px dashed ${C.border}`, borderRadius: 8,
          padding: "10px 12px", fontSize: 12, color: C.muted, marginBottom: 12,
        }}>
          Need ≥5 {grip} failures across ≥3 different target durations to seed the
          baseline fit. Push to failure on a few sessions and the ladder unlocks.
        </div>
      )}

      {/* Progress to next badge */}
      {genesisEarned && nextBadge && baseline && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: C.muted }}>
              Progress to {nextBadge.emoji} {nextBadge.label}
            </span>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.blue }}>{toNext.toFixed(0)}%</span>
          </div>
          <div style={{ height: 5, background: C.border, borderRadius: 3 }}>
            <div style={{
              height: "100%", borderRadius: 3, background: C.blue,
              width: `${toNext}%`, transition: "width 0.4s",
            }} />
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 5 }}>
            Need +{nextBadge.threshold}% · you're at +{pctImprove.toFixed(1)}%
          </div>
        </div>
      )}

      {/* All-earned celebration */}
      {genesisEarned && !nextBadge && (
        <div style={{
          background: "#1a2a1a", border: `1px solid ${C.green}`,
          borderRadius: 10, padding: "10px 12px", textAlign: "center",
          fontSize: 12, color: C.green, fontWeight: 700,
        }}>
          🏆 All ranks earned for {grip} — you've maxed the ladder
        </div>
      )}

      {/* Compact badge ladder (current ± 2, plus first/last as anchors) */}
      {genesisEarned && baseline && (
        <details style={{ marginTop: 12 }}>
          <summary style={{
            cursor: "pointer", fontSize: 11, color: C.muted,
            letterSpacing: "0.06em", textTransform: "uppercase",
            paddingLeft: 4, listStyle: "none",
          }}>
            ▸ Show full {grip} ladder ({earnedList.length}/{BADGE_CONFIG.length})
          </summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
            {BADGE_CONFIG.map(badge => {
              const earned  = earnedIds.has(badge.id);
              const isCurr  = currentBadge?.id === badge.id;
              return (
                <div key={badge.id} style={{
                  background: earned ? C.bg : "transparent",
                  border: `1px solid ${isCurr ? C.blue : earned ? C.border : C.border + "40"}`,
                  borderRadius: 8, padding: "8px 12px",
                  display: "flex", alignItems: "center", gap: 10,
                  opacity: earned ? 1 : 0.45,
                }}>
                  <span style={{ fontSize: 20, filter: earned ? "none" : "grayscale(1)" }}>
                    {badge.emoji}
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{
                      fontSize: 13, fontWeight: 700,
                      color: isCurr ? C.blue : earned ? C.text : C.muted,
                    }}>
                      {badge.label}
                      {isCurr && (
                        <span style={{
                          marginLeft: 6, fontSize: 9, fontWeight: 700, color: C.blue,
                          background: C.blue + "22", borderRadius: 3,
                          padding: "1px 5px", letterSpacing: "0.05em",
                        }}>NOW</span>
                      )}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, minWidth: 40, textAlign: "right" }}>
                    {badge.threshold === 0 ? "start" : `+${badge.threshold}%`}
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}

export function BadgesView({ history = [], threeExpPriors = null }) {
  // Discover which grips the user has trained (any rep counts —
  // including pre-Genesis warmup reps). Sorted alphabetically for
  // stable order across renders. Empty case shows a "log a session"
  // empty state instead of two empty grip cards.
  const grips = useMemo(() => {
    const set = new Set();
    for (const r of history || []) {
      if (r?.grip) set.add(r.grip);
    }
    return [...set].sort();
  }, [history]);

  return (
    <div style={{ padding: "20px 16px", maxWidth: 520, margin: "0 auto" }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 14, textAlign: "center", letterSpacing: "0.08em" }}>
        YOUR JOURNEY
      </div>

      {grips.length === 0 ? (
        <div style={{
          background: C.card, border: `1px dashed ${C.border}`, borderRadius: 12,
          padding: "20px 16px", textAlign: "center", color: C.muted, fontSize: 13,
        }}>
          Log your first session in any grip to begin the journey.
        </div>
      ) : (
        grips.map(grip => (
          <GripJourney
            key={grip}
            grip={grip}
            history={history}
            threeExpPriors={threeExpPriors}
          />
        ))
      )}

      <div style={{ fontSize: 11, color: C.muted, textAlign: "center", marginTop: 16, lineHeight: 1.5, fontStyle: "italic" }}>
        Each grip earns its own ranks. AUC = total area under your three-exp F-D curve from 5s to 180s — a single number that goes up as your power, strength, AND endurance improve together.
      </div>
    </div>
  );
}
