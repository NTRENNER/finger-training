// ─────────────────────────────────────────────────────────────
// SESSION PLAN CARD — single-box session picker for Setup
// ─────────────────────────────────────────────────────────────
// Replaces three previously-separate Setup surfaces:
//   * ContinuousPickCard ("Recommended Session" big-numbers card)
//   * PrescribedLoadCard's role on Setup (six zone tiles)
//   * SessionRPECard ("Session RPE — today")
//
// The unified flow (top → bottom):
//   1. Recommended button — the primary tile (TARGET / LOAD / L·R / Why).
//      It shows the density ladder's resolved next-workout plan when
//      available, otherwise the curve recommendation. Clickable: tapping
//      it clears any tile override and makes the recommendation the active
//      selection (highlighted bright). When the user has overridden via an
//      alternative tile, this button dims but still surfaces the curve pick.
//   2. Cookedness slider — "How cooked today?" (0–10, defaults to fresh).
//      Scales the prescribed LOAD per-grip via exp(-β·c) without
//      changing which zone the engine picks. Upserted to daily_state
//      on session start so the server-side trigger can update β from
//      every rep-1 insert.
//   3. Override indicator + protocol controls — hangs/rest/time strip,
//      hangs and rest sliders. Defaults track the active selection's
//      T but stick once touched.
//   4. Six zone tiles — alternatives. Tap any to override the
//      recommendation; the recommended button above dims and the
//      tapped tile gets the bright highlight. Loads on every tile
//      reflect the RPE slider's per-zone scale-down.
//
// One TARGET/LOAD display total. Pre-merge there was a duplicate big-
// numbers panel below the slider — Recommended panel now serves both
// "what did the curve recommend" and "what's selected" since it's the
// primary tile. The bright highlight on whichever tile is active (the
// big Recommended button OR one of the small alternatives) is the
// single source of truth for the active selection.
//
// All three sections share state, so flipping the slider flows through
// the tiles and the details simultaneously, and clicking a tile drives
// what the workout runner gets via onApplyPlan({goal, targetTime, ...}).
//
// PrescribedLoadCard still exists in src/views/cards/ — Analysis renders
// it standalone for retrospective what-if exploration, where the slider
// is purely local (no workout to drive). Both components share the same
// per-grip cookedness math through fatigueBeta.capacityMultiplier.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { C } from "../../ui/theme.js";
import { Card, Btn } from "../../ui/components.js";
import { fmtW } from "../../ui/format.js";
import { ZONE_KEYS } from "../../model/zones.js";
import { prescription } from "../../model/prescription.js";
import {
  coachingRecommendationContinuous,
  FRESH_TEST_SHORT_T_MAX,
} from "../../model/coaching.js";
import { maxTestStaleness } from "../../model/peakForce.js";
import { ymdLocal } from "../../util.js";
import { decisiveWhy } from "../../model/coachNotes.js";
import { capacityMultiplier } from "../../model/fatigueBeta.js";
import { suggestCookedFromClimbs } from "../../model/climbingFatigue.js";
import {
  computeDensityLadder, resolveDensityLadderLoads,
  LADDER_MAX_REPS, LADDER_MIN_REPS, LADDER_LOAD_STEP_FRAC,
  LADDER_COLLAPSE_STEP_FRAC,
} from "../../model/densityLadder.js";
import { today } from "../../util.js";

// Display labels for the climbing-focus pill in the header. Kept here
// (vs imported from coaching.js) because coaching.js exports the
// multiplier table by key, not a human-readable label set.
const FOCUS_LABEL = {
  bouldering: "Bouldering",
  power_endurance: "Power Endurance",
  endurance: "Endurance",
};

export function SessionPlanCard({
  history, grip, freshMap, threeExpPriors, activities = [],
  GOAL_CONFIG, unit, hand = "Both",
  // onApplyPlan flows the active session config (zone, T, reps, rest)
  // back up so the workout runner uses it. Auto-fires whenever any of
  // those change.
  onApplyPlan,
  // "How cooked today?" slider state (0 = fresh → 10 = wrecked). Owned
  // by SetupView; flows through to useSessionRunner which upserts it to
  // daily_state on session start. Mandatory: null means "not yet picked"
  // and the Start button stays disabled.
  cooked,
  onCookedChange,
  // Per-grip β model from user_settings.settings.fatigue_model. Used
  // to compute the load scale-down: prescribedLoad = freshLoad ×
  // exp(-β_grip · cooked). Replaces the old per-zone applyPersonalGain.
  fatigueModel = null,
  // Cloud-synced climbing-focus bias ("balanced" | "bouldering" |
  // "power_endurance" | "endurance"). Threaded to the engine to
  // apply per-zone multipliers that nudge close calls toward the
  // user's training goal.
  climbingFocus = "balanced",
  // Optional callback wired to the focus pill in the header — tapping
  // it jumps to Settings so the user can change focus in one tap when
  // priorities shift (climbing trip, recovery week). Pill only renders
  // when climbingFocus is non-default ("balanced" stays hidden).
  onNavigateToSettings,
  // One-tap peak-test launcher (SetupView.startMaxTest) — replaces the
  // old Why-line peak-test advisory text with an action (July 2026).
  onStartMaxTest = null,
}) {
  // ── Recommendation from the continuous engine ──────────────
  // coachingRecommendationContinuous ignores perceivedFatigue +
  // personalGains opts ("intentionally not consumed" — see
  // model/coaching.js). We still pass cooked through for future
  // engine consumption but the recommendation today is fatigue-blind.
  const rec = useMemo(
    () => grip
      ? coachingRecommendationContinuous(history, grip, {
          freshMap, threeExpPriors, activities,
          perceivedFatigue: cooked || 0,
          climbingFocus,
        })
      : null,
    [history, grip, freshMap, threeExpPriors, activities, cooked, climbingFocus]
  );
  const recommendedZone = rec?.zone;

  // Peak-test cadence (MVP): is a fresh MEASURED max reading overdue for
  // this grip? Computed here from grip-filtered history (the coaching
  // engine stays untouched); drives the actionable "peak test due" nudge
  // in the Why line. Suppressed while the engine is cold-starting a new
  // grip (a max test comes after the curve is seeded).
  const maxTest = useMemo(
    () => grip && !rec?.coldStart
      ? maxTestStaleness(history.filter(r => r?.grip === grip), ymdLocal())
      : null,
    [history, grip, rec]
  );

  // ── Climb-derived cookedness suggestion ──────────────────────
  // Derived from today's (+ decayed yesterday's) logged climbs — see
  // suggestCookedFromClimbs. Pre-fills the slider ONCE per mount when
  // the user hasn't touched it (cooked still at the 0 default / null);
  // any manual slider interaction pins their value for the rest of
  // the session setup. The provenance note below the slider keeps the
  // suggestion visible even after an override, with a one-tap apply.
  const cookedSuggestion = useMemo(
    () => suggestCookedFromClimbs(activities, today()),
    [activities]
  );
  const cookedTouchedRef = useRef(false);
  useEffect(() => {
    if (cookedTouchedRef.current) return;
    if (!cookedSuggestion || !(cookedSuggestion.cooked > 0)) return;
    if (cooked != null && cooked !== 0) return;  // user/day value already set
    onCookedChange?.(cookedSuggestion.cooked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cookedSuggestion]);

  // ── Active zone — defaults to recommended, user can override via tiles ──
  // Stored as the zone key (e.g. "power") or null = "follow recommendation"
  const [overrideZone, setOverrideZone] = useState(null);
  // Why-line Details expander (July 2026) — receipts and secondary
  // factors hide behind a tap so the headline stays one sentence.
  const [showDetails, setShowDetails] = useState(false);
  const activeZone = overrideZone || recommendedZone;
  const isOverridden = overrideZone && overrideZone !== recommendedZone;

  // Reset the override when the grip changes — a Crusher pick shouldn't
  // carry into Micro silently.
  useEffect(() => { setOverrideZone(null); }, [grip]);

  // ── Density ladder for the active (grip, zone) ───────────────
  // Next-workout progression at constant load, gated by the previous
  // session's first/last reps and completeness (see densityLadder.js).
  // Non-null whenever this (grip, zone) has been trained before — in
  // that case the ladder pins T, resolves the next load, and prescribes
  // the rep count, while the engine still owns WHICH zone gets
  // recommended. New (grip, zone) combos use the curve-fit defaults.
  const expectedHands = useMemo(
    () => hand === "Both" ? ["L", "R"] : [hand === "R" ? "R" : "L"],
    [hand]
  );
  const ladder = useMemo(
    () => (grip && activeZone)
      ? computeDensityLadder(history, grip, activeZone, {
          fatigueModel,
          expectedHands,
        })
      : null,
    [history, grip, activeZone, fatigueModel, expectedHands]
  );

  // ── Per-zone tiles (with per-grip cookedness scale-down) ─────────
  // Every tile gets the same multiplier because β is per-grip. If
  // zone-specific suppression becomes important again, swap in a
  // (grip, zone) β table here — the rest of the wiring stays.
  const rows = useMemo(() => {
    if (!grip) return null;
    const fatigueMod = capacityMultiplier(fatigueModel, grip, cooked);
    return ZONE_KEYS.map(key => {
      const cfg = GOAL_CONFIG[key];
      if (!cfg) return null;
      const T = cfg.refTime;
      const pL = prescription(history, "L", grip, T, { freshMap, threeExpPriors });
      const pR = prescription(history, "R", grip, T, { freshMap, threeExpPriors });
      return {
        key, label: cfg.label, emoji: cfg.emoji, color: cfg.color, T,
        L: pL?.value != null ? pL.value * fatigueMod : null,
        R: pR?.value != null ? pR.value * fatigueMod : null,
        fatigueMod,
        // Reliability dimming — same logic as PrescribedLoadCard.
        reliability:
          !pL && !pR ? null
          : pL?.reliability === "extrapolation" || pR?.reliability === "extrapolation" ? "extrapolation"
          : pL?.reliability === "marginal" || pR?.reliability === "marginal" ? "marginal"
          : "well-supported",
      };
    }).filter(Boolean);
  }, [history, grip, freshMap, threeExpPriors, GOAL_CONFIG, fatigueModel, cooked]);

  // ── Active row — drives the bottom session-details panel ──────────────
  const activeRow = activeZone && rows ? rows.find(r => r.key === activeZone) : null;
  // T comes from rec (the engine's argmax in the continuous sweep) when
  // we're on the recommended zone; from the zone's refTime when the user
  // has overridden. The density ladder pins the PREVIOUS session's T
  // for repeat (grip, zone) combos — protocol comparability requires
  // holding T constant while reps climb, so the pin wins over both.
  const curveT = isOverridden
    ? activeRow?.T
    : (rec?.T ?? activeRow?.T);
  const activeT = ladder?.T ?? curveT;
  // A first-rep miss removes that hand's old pin from the ladder.
  // Re-fit at the same T using the now-complete session, then resolve
  // the final next-workout loads with a guaranteed modest reduction
  // if the curve itself did not move down. Missing hands from an
  // incomplete Both-mode session also use their current curve load.
  const ladderCurveLoadByHand = useMemo(() => {
    if (!ladder || !(activeT > 0)) return null;
    const out = {};
    for (const h of expectedHands) {
      if (Number(ladder.loadByHand?.[h]) > 0) continue;
      const p = prescription(history, h, grip, activeT, { freshMap, threeExpPriors });
      if (p?.value > 0) out[h] = p.value;
    }
    return out;
  }, [ladder, activeT, expectedHands, history, grip, freshMap, threeExpPriors]);
  const ladderPlanLoadByHand = useMemo(
    () => resolveDensityLadderLoads(ladder, ladderCurveLoadByHand),
    [ladder, ladderCurveLoadByHand]
  );
  // Per-hand load values used to feed a separate "active TARGET/LOAD"
  // big-numbers panel — that panel was retired May 2026 since the
  // Recommended button (above) and the highlighted alternative tile
  // (below) already make the active selection visually obvious.
  // activeT is still used by the protocol controls (hangs/rest defaults
  // + total-time math).
  const activeColor = activeRow?.color ?? C.blue;
  const activeEmoji = activeRow?.emoji ?? "🎯";
  const activeLabel = activeRow?.label ?? activeZone;

  // ── Reps / Rest defaults from the active T ───────────────────
  // Ladder reps win for repeat (grip, zone) sessions; the T-derived
  // formula is the cold-start default for combos with no history.
  // Protocol-driven, no manual override (June 2026): the Hangs/Rest
  // sliders were removed — the ladder (or the T-derived default for
  // new combos) owns the rep count, and rest is a protocol constant.
  // The sliders were never deliberately used and were an accidental-
  // bump hazard; commitment to the protocol is the point of the
  // ladder. The Hangs/Rest/Time summary strip below still shows the
  // plan read-only.
  const reps = ladder
    ? ladder.reps
    : activeT
      ? Math.max(4, Math.min(6, Math.round(6 - (activeT - 5) / 117.5)))
      : 5;
  const rest = 20;

  // ── Push to session config ──────────────────────────────────
  // ladderLoadByHand: fresh-equivalent pinned loads when the density
  // ladder is active (null otherwise). useSessionRunner.startSession
  // prefers these over a fresh prescription() call so the "same
  // weight, more reps" contract actually holds — re-prescribing from
  // the curve would drift the load between ladder rungs.
  useEffect(() => {
    if (!activeZone || !activeT) return;
    onApplyPlan?.({
      goal: activeZone,
      targetTime: activeT,
      repsPerSet: reps,
      restTime: rest,
      ladderLoadByHand: ladder ? ladderPlanLoadByHand : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeZone, activeT, reps, rest, ladder, ladderPlanLoadByHand]);

  // ── Empty / loading states ───────────────────────────────────
  if (!grip) {
    return (
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>Session Plan</div>
        <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
          Pick a grip above to see your continuous prescription.
        </div>
      </Card>
    );
  }
  if (!rec || !rows) {
    return (
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>Session Plan</div>
        <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
          Need at least 2 reps on this grip to fit a curve. Run a probe
          session at any duration to get started.
        </div>
      </Card>
    );
  }

  // ── Why-line (July 2026 redesign) ─────────────────────────
  // ONE plain sentence for the engine's decisive factor (decisiveWhy in
  // model/coachNotes.js) — explanation, not persuasion; coaching never
  // argues with the recommender. Everything the old run-on line carried
  // (staleness arguments, coverage pleas, focus math, receipts) moves
  // behind a tap-to-expand Details toggle, and the peak-test advisory
  // is an actual button now (see onStartMaxTest below). When the
  // density ladder owns the plan, the headline explains the protocol —
  // those ARE the numbers on screen — and the curve's own decisive
  // factor drops into Details.
  const ladderText = (() => {
    if (!ladder) return null;
    const lb = ladder.basis;
    const lMult = capacityMultiplier(fatigueModel, grip, cooked);
    const loadStr = ["L", "R"]
      .filter(h => ladderPlanLoadByHand?.[h] != null)
      .map(h => `${h} ${fmtW(ladderPlanLoadByHand[h] * lMult, unit)}`)
      .join(" / ");
    const notes = [];
    if (Object.keys(lb.boundedByHand || {}).length) {
      notes.push("pin capped by the engine's load ceiling");
    }
    const collapsedHands = Object.keys(lb.collapseByHand || {});
    if (collapsedHands.length && ladder.decision !== "down_step") {
      notes.push(`${collapsedHands.join("+")} load also stepped down after recovery collapse`);
    }
    const suffix = notes.length ? ` — ${notes.join("; ")}` : "";
    if (ladder.decision === "recalibrate") {
      const misses = lb.shortfallHands
        .map(h => `${h} rep 1 ${lb.firstRepSecByHand[h]}s`)
        .join(", ");
      return `ladder: ${misses} missed the ${lb.firstRepTargetSec}s minimum for a ${ladder.T}s target → next workout lowers load (${loadStr} ${unit}) and repeats ${ladder.reps} reps${suffix}`;
    }
    if (ladder.decision === "incomplete") {
      const detail = lb.missingHands.length > 0
        ? `missing ${lb.missingHands.join("/")}`
        : "uneven rep counts";
      return `ladder: last workout incomplete (${detail}) → repeat ${ladder.reps} reps, no advance (${loadStr} ${unit})${suffix}`;
    }
    if (ladder.decision === "down_step") {
      // Collapse down-step (July 2026): reps 2+ decayed below the
      // personal recovery model's forecast last time, so the load
      // steps down 10% and the rung holds. Show the worst hand's C so
      // the claim is inspectable.
      const worstC = Math.min(...Object.values(lb.collapseByHand || {}).map(c => c.C));
      return `ladder: last session's reps 2+ decayed to ${Math.round(worstC * 100)}% of your recovery model's forecast → −${Math.round(LADDER_COLLAPSE_STEP_FRAC * 100)}% load (${loadStr} ${unit}), same ${ladder.reps} reps until it's absorbed${suffix}`;
    }
    if (ladder.decision === "advance") {
      return `ladder: last rep ${lb.lastRepSec}s ≥ ${lb.gateSec}s gate → ${ladder.reps} reps, same load (${loadStr} ${unit})${suffix}`;
    }
    if (ladder.decision === "repeat") {
      return `ladder: last rep ${lb.lastRepSec}s < ${lb.gateSec}s gate → repeat ${ladder.reps} reps, same load (${loadStr} ${unit})${suffix}`;
    }
    return `ladder: topped out at ${LADDER_MAX_REPS} reps → +${Math.round(LADDER_LOAD_STEP_FRAC * 100)}% load (${loadStr} ${unit}), back to ${LADDER_MIN_REPS} reps${suffix}`;
  })();
  const whyText = decisiveWhy(rec, { ladderText });

  // Secondary factors + receipts, shown only on demand. Any line that
  // duplicates the headline is filtered out at the end.
  const detailParts = [];
  if (ladderText) {
    const curveWhy = decisiveWhy(rec);
    if (curveWhy) detailParts.push(curveWhy);
  }
  if (rec.adaptBoost != null && rec.adaptBoost < 0.85 && !rec.coverageSnap) {
    detailParts.push("you're at or above the modeled curve everywhere — picked on staleness alone");
  }
  if (rec.staleStatus === "stale") {
    detailParts.push(`${rec.zone.replace(/_/g, " ")} zone is past its detraining window`);
  } else if (rec.staleStatus === "warning") {
    detailParts.push(`${rec.zone.replace(/_/g, " ")} zone is approaching stale`);
  }
  if (rec.coverageSnap) {
    detailParts.push("centered in the zone (heavier · shorter) so a strong rep still lands in-window");
  }
  if (rec.recency != null && rec.recency < 0.5) {
    detailParts.push("zone partially recovered — lighter dose is fine");
  }
  if (rec.confidence != null && rec.confidence < 0.5) {
    detailParts.push("sparse data here — log a clean rep to anchor the curve");
  }
  if (rec.focus != null && rec.focus !== 1.0 && rec.climbingFocus && rec.climbingFocus !== "balanced") {
    const fPct = Math.round((rec.focus - 1) * 100);
    const focusLabel = rec.climbingFocus === "power_endurance" ? "power endurance" : rec.climbingFocus;
    detailParts.push(fPct > 0
      ? `${focusLabel} focus added +${fPct}%`
      : `${focusLabel} focus despite −${Math.abs(fPct)}% de-emphasis`);
  }
  // Short-T picks keep their freshness caveat — it changes how you
  // should RUN the session, so it stays visible in Details.
  const pickIsShort = activeT != null && activeT <= FRESH_TEST_SHORT_T_MAX;
  if (pickIsShort) {
    if (cookedSuggestion && cookedSuggestion.todayFatigue != null && cookedSuggestion.cooked >= 4) {
      detailParts.push("⚠️ you've climbed today — a max effort now will read low; consider a fresh day");
    } else {
      detailParts.push("do this fresh — before climbing — so it anchors the curve's top end honestly");
    }
  }
  const detailShown = detailParts.filter(pt => pt && pt !== whyText);

  // Total session time (per-hand × 2 if Both)
  const perHandSec = (reps || 0) * (activeT || 0) + Math.max(0, (reps || 1) - 1) * (rest || 0);
  const both = hand === "Both";
  const totalSec = both ? perHandSec * 2 : perHandSec;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const timeStr = `~${m}:${String(s).padStart(2, "0")}${both ? " (both)" : ""}`;

  // ── Render ─────────────────────────────────────────────────
  return (
    <Card style={{ marginBottom: 16, border: `1px solid ${activeColor}66` }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>
          Session Plan · {grip}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          {/* Climbing-focus pill — only renders when focus is non-default.
              Passive context indicator (not an action): tells the user the
              engine is biased toward a particular zone family for the goal
              they're training for. Tap to jump to Settings. The Why-line
              still surfaces the actual multiplier when focus nudges the
              winning zone; this pill is for awareness even when focus
              wasn't the tipping factor. */}
          {climbingFocus && climbingFocus !== "balanced" && (
            <button
              onClick={() => onNavigateToSettings?.()}
              title="Change in Settings"
              style={{
                fontSize: 10, fontWeight: 600, letterSpacing: 0.2,
                padding: "2px 8px", borderRadius: 10,
                background: "transparent", color: C.muted,
                border: `1px solid ${C.border}`,
                cursor: onNavigateToSettings ? "pointer" : "default",
                font: "inherit",
              }}
            >
              🧗 {FOCUS_LABEL[climbingFocus] ?? climbingFocus} focus
            </button>
          )}
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
            padding: "2px 8px", borderRadius: 10,
            background: activeColor + "22", color: activeColor,
          }}>
            {activeEmoji} {activeLabel}
          </div>
        </div>
      </div>

      {/* Recommended Session. When following the recommendation and a
          density ladder is active, show the resolved NEXT-workout T/load
          that the runner will actually use. With no ladder (or while an
          alternative tile is selected), retain the continuous engine's
          recommendation. The cookedness multiplier remains identical
          between display and runner. */}
      {(() => {
        const recCfg = GOAL_CONFIG[rec.zone] ?? { color: C.blue, label: rec.zone, emoji: "🎯" };
        // Per-grip cookedness multiplier — same factor the tiles below
        // and the runner use. Multiplied through rec.loadKg and the
        // per-hand values so the Recommended card stays in sync with
        // the rest of the screen as the slider moves.
        const recMult = capacityMultiplier(fatigueModel, grip, cooked);
        // When the density ladder is active for the recommended zone
        // (i.e. NOT overridden), the session runs the ladder's pinned
        // T + load (see activeT / ladderLoadByHand). The headline must
        // show THOSE, not the raw curve argmax, so the big numbers match
        // the Why line, the Hangs/Rest/Time strip, and the live session.
        // Under a tile override the ladder belongs to the override zone,
        // so the Recommended card falls back to the engine's curve pick.
        const recLadder = isOverridden ? null : ladder;
        const recT = recLadder ? recLadder.T : rec.T;
        let recLoadKg, recL, recR;
        if (recLadder && ladderPlanLoadByHand) {
          recL = ladderPlanLoadByHand.L != null ? ladderPlanLoadByHand.L * recMult : null;
          recR = ladderPlanLoadByHand.R != null ? ladderPlanLoadByHand.R * recMult : null;
          const vals = [recL, recR].filter(v => v != null);
          recLoadKg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        } else {
          recLoadKg = rec.loadKg != null ? rec.loadKg * recMult : rec.loadKg;
          recL = rec.loadByHand?.L != null ? rec.loadByHand.L * recMult : null;
          recR = rec.loadByHand?.R != null ? rec.loadByHand.R * recMult : null;
        }
        const recScalePct = recMult < 0.999 ? Math.round((1 - recMult) * 100) : 0;
        // Recommended is the primary "tile" — clickable like the small
        // alternatives below. Tapping it clears any override (back to
        // the engine's pick). Active when no override is in effect.
        const recActive = !isOverridden;
        return (
          <button
            onClick={() => setOverrideZone(null)}
            style={{
              display: "block", width: "100%", textAlign: "left",
              cursor: "pointer", font: "inherit",
              marginBottom: 12, padding: "12px 14px", borderRadius: 10,
              background: recActive ? recCfg.color + "22" : C.bg,
              border: recActive
                ? `2px solid ${recCfg.color}`
                : `1px solid ${recCfg.color}66`,
              opacity: recActive ? 1 : 0.7,
              // Compensate the 2px active border so the card height
              // doesn't jump when toggling override on/off.
              margin: recActive ? "0 0 12px 0" : "1px 1px 13px 1px",
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: recCfg.color, textTransform: "uppercase", letterSpacing: 0.5 }}>
                ★ Recommended
              </div>
              <div style={{ fontSize: 10, fontWeight: 700, color: recCfg.color }}>
                {recCfg.emoji} {recCfg.label}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
              <div style={{ flex: 1, textAlign: "center" }}>
                <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>Target</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: recCfg.color, lineHeight: 1 }}>
                  {recT}<span style={{ fontSize: 13, color: C.muted, marginLeft: 2 }}>s</span>
                </div>
              </div>
              <div style={{ flex: 1, textAlign: "center" }}>
                <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  Load
                  {recScalePct > 0 && (
                    <span style={{ marginLeft: 6, color: C.orange, fontWeight: 700 }}>
                      −{recScalePct}%
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 28, fontWeight: 800, color: C.blue, lineHeight: 1 }}>
                  {fmtW(recLoadKg, unit)}<span style={{ fontSize: 11, color: C.muted, marginLeft: 4 }}>{unit}</span>
                </div>
                {(recL != null || recR != null) && (
                  <div style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>
                    {recL != null && <>L {fmtW(recL, unit)}</>}
                    {recL != null && recR != null && " · "}
                    {recR != null && <>R {fmtW(recR, unit)}</>}
                  </div>
                )}
              </div>
            </div>
            <div style={{ marginTop: 10, fontSize: 11, color: C.muted, lineHeight: 1.5 }}>
              <span style={{ color: recCfg.color, fontWeight: 700 }}>Why: </span>
              {whyText}
              {detailShown.length > 0 && (
                <span
                  onClick={(e) => { e.stopPropagation(); setShowDetails(v => !v); }}
                  style={{ marginLeft: 6, color: recCfg.color, cursor: "pointer", fontWeight: 700 }}
                >
                  {showDetails ? "− less" : `+${detailShown.length} more`}
                </span>
              )}
            </div>
            {showDetails && detailShown.length > 0 && (
              <div style={{
                marginTop: 6, paddingTop: 6, borderTop: `1px solid ${C.border}`,
                fontSize: 10.5, color: C.muted, lineHeight: 1.6, textAlign: "left",
              }}>
                {detailShown.map((pt, i) => <div key={i}>· {pt}</div>)}
              </div>
            )}
          </button>
        );
      })()}

      {/* Peak-test cadence — an action, not advisory text (July 2026):
          one tap runs SetupView.startMaxTest (3×3s target-less max
          preset via startSession's override path). Hidden when the
          active pick is already short-T — that IS a max effort. */}
      {maxTest?.recommended && onStartMaxTest && !pickIsShort && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
          padding: "8px 10px", marginBottom: 12, borderRadius: 8,
          background: C.blue + "11", border: `1px solid ${C.blue}44`,
        }}>
          <div style={{ fontSize: 11, color: C.text, lineHeight: 1.4 }}>
            🎯 Peak test due — {maxTest.staleDays == null
              ? "no measured max on record"
              : `last reading ${maxTest.staleDays}d ago`}. Refreshes your top line and anchors the curve.
          </div>
          <Btn small color={C.blue} onClick={onStartMaxTest}>Start peak test</Btn>
        </div>
      )}

      {/* "How cooked today?" slider — 0–10 pre-workout state, defaults
          to 0 (fresh, multiplier = 1, no scale-down). Higher values apply
          exp(-β_grip · cooked) to the prescribed load. Optional: leave it
          at fresh on a normal day; raise it only when you're not. */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "10px 12px", marginBottom: 12,
        borderRadius: 8,
        background: C.bg,
        border: `1px solid ${C.border}`,
      }}>
        <div style={{ flex: "0 0 auto" }}>
          <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 2 }}>
            How cooked today?
          </div>
          <div style={{ fontSize: 10, color: C.muted }}>
            {cooked === 0
              ? "fresh — no scale-down"
              : `cooked ${cooked}/10`}
            {cooked > 0 && grip && (() => {
              // Report the multiplier ACTUALLY applied (fixed manual
              // scaling — see fatigueBeta.capacityMultiplier). The old
              // label computed exp(-β·cooked) directly and advertised
              // a discount that was never applied while scaling was
              // disabled (July 2026).
              const mult = capacityMultiplier(fatigueModel, grip, cooked);
              const pct = Math.round((1 - mult) * 100);
              if (pct < 1) return null;
              return (
                <span style={{ marginLeft: 6, color: C.purple, fontStyle: "italic" }}>
                  · {pct}% scale-down
                </span>
              );
            })()}
          </div>
        </div>
        <input
          type="range" min={0} max={10} step={1}
          value={cooked ?? 0}
          onChange={e => {
            cookedTouchedRef.current = true;  // manual edit pins the value
            onCookedChange?.(Number(e.target.value));
          }}
          style={{
            flex: 1,
            accentColor: C.orange,
          }}
          aria-label="Cookedness (0 fresh, 10 wrecked)"
        />
        {cooked > 0 && (
          <button
            onClick={() => {
              cookedTouchedRef.current = true;
              onCookedChange?.(0);
            }}
            style={{
              flex: "0 0 auto", fontSize: 10, padding: "2px 8px",
              borderRadius: 4, border: `1px solid ${C.border}`,
              background: "transparent", color: C.muted, cursor: "pointer",
            }}
          >fresh</button>
        )}
      </div>

      {/* Provenance note for the climb-derived suggestion. Shown
          whenever there's climb-log signal for today/yesterday so the
          user can see WHY the slider pre-filled — and re-apply with
          one tap after overriding. */}
      {cookedSuggestion && cookedSuggestion.cooked > 0 && (
        <div style={{
          fontSize: 10, color: C.muted, margin: "-6px 2px 12px",
          lineHeight: 1.4, fontStyle: "italic",
        }}>
          Climb log suggests <b style={{ color: C.orange }}>{cookedSuggestion.cooked}/10</b>
          {" — "}
          {cookedSuggestion.todayFatigue != null
            ? `${cookedSuggestion.nClimbsToday} climb${cookedSuggestion.nClimbsToday === 1 ? "" : "s"} logged today`
            : "no climbs today"}
          {cookedSuggestion.yesterdayFatigue != null && " + yesterday's session"}
          {cooked !== cookedSuggestion.cooked && (
            <button
              onClick={() => {
                cookedTouchedRef.current = true;
                onCookedChange?.(cookedSuggestion.cooked);
              }}
              style={{
                background: "none", border: "none", color: C.orange,
                fontSize: 10, cursor: "pointer", padding: 0, marginLeft: 6,
                textDecoration: "underline", fontStyle: "normal",
              }}
            >apply</button>
          )}
        </div>
      )}

      {/* Override indicator — shows up when the user has selected a tile
          other than the recommended one. Click to revert. */}
      {isOverridden && (
        <div style={{ marginBottom: 10, fontSize: 11, color: C.muted, textAlign: "center" }}>
          overriding the recommendation ({rec.zone.replace(/_/g, " ")} →{" "}
          {activeZone.replace(/_/g, " ")}) ·{" "}
          <button
            onClick={() => setOverrideZone(null)}
            style={{ background: "none", border: "none", color: C.purple, cursor: "pointer", fontSize: 11, padding: 0, textDecoration: "underline" }}
          >back to recommended</button>
        </div>
      )}


      {/* Hangs / Rest / Time strip */}
      <div style={{
        display: "flex", gap: 6, marginBottom: 12,
        background: C.bg, borderRadius: 10, padding: "10px 14px", alignItems: "center",
      }}>
        {[
          { label: "Hangs", value: reps },
          { label: "Rest",  value: `${rest}s` },
          { label: "Time",  value: timeStr },
        ].map(({ label, value }, i, arr) => (
          <React.Fragment key={label}>
            <div style={{ textAlign: "center", flex: 1 }}>
              <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: activeColor }}>{value}</div>
            </div>
            {i < arr.length - 1 && <div style={{ color: C.border, fontSize: 16 }}>·</div>}
          </React.Fragment>
        ))}
      </div>

      {/* (Hangs + Rest sliders removed June 2026 — protocol-driven;
          see the comment at the reps/rest derivation above.) */}

      {/* Six zone tiles — alternatives. Tap any tile to override the
          recommended pick for this session; the active session block
          above updates immediately to reflect the new target T and
          load. The recommended tile gets a ★ + double-strength border;
          the active (selected) tile gets the bright background tint.
          Loads on every tile reflect the RPE slider's per-zone scale-
          down so the user sees the trade-off across the full curve. */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
        {rows.map(r => {
          // Tile is "active" only when it's the user's override pick.
          // When no override is in effect, the Recommended button above
          // is the active selection — even though that pick lives in
          // the same zone as one of these tiles, the two represent
          // different things: the Recommended button shows the
          // continuous-engine T (e.g. 50s with curve-fitted load), the
          // matching tile shows the zone's reference T (e.g. 70s with
          // T-anchored load). Highlighting both would imply they're
          // interchangeable, which they aren't.
          const isActive = isOverridden && r.key === activeZone;
          const isRec = r.key === recommendedZone;
          const dim = r.reliability === "extrapolation";
          const scalePct = r.fatigueMod < 0.999 ? Math.round((1 - r.fatigueMod) * 100) : 0;
          return (
            <button
              key={r.key}
              onClick={() => setOverrideZone(r.key === recommendedZone ? null : r.key)}
              style={{
                textAlign: "left", cursor: "pointer", font: "inherit",
                padding: "10px 12px", borderRadius: 8,
                background: isActive ? r.color + "22" : C.bg,
                border: isActive
                  ? `2px solid ${r.color}`
                  : `1px solid ${C.border}`,
                opacity: dim ? 0.55 : 1,
                // Compensate the active border thickness so tiles stay aligned
                margin: isActive ? 0 : 1,
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: r.color }}>
                  {r.emoji} {r.label}
                  {isRec && (
                    <span style={{ marginLeft: 4, fontSize: 9, color: C.muted, fontWeight: 500 }}>★</span>
                  )}
                </div>
                <div style={{ fontSize: 10, color: C.muted }}>
                  {scalePct > 0 && <span style={{ marginRight: 6, color: C.orange }}>−{scalePct}%</span>}
                  {r.T}s
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>L</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: C.blue, lineHeight: 1 }}>
                    {r.L != null ? fmtW(r.L, unit) : "—"}
                  </div>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>R</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: C.blue, lineHeight: 1 }}>
                    {r.R != null ? fmtW(r.R, unit) : "—"}
                  </div>
                </div>
              </div>
              {r.reliability === "extrapolation" && (
                <div style={{ fontSize: 9, color: C.muted, marginTop: 4, fontStyle: "italic" }}>
                  extrapolating
                </div>
              )}
            </button>
          );
        })}
      </div>
    </Card>
  );
}
