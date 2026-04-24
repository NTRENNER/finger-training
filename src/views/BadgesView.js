// ─────────────────────────────────────────────────────────────
// BADGES / JOURNEY VIEW
// ─────────────────────────────────────────────────────────────
// Renders the "Journey" tab: a vertical pyramid of seven milestone
// badges from Genesis (one session in every zone) to Realization
// (2× the user's Genesis AUC). The current badge floats at the top
// as a hero element; progress toward the next badge is shown as a
// percentage bar.
//
// Pure read-only view — no mutations, no localStorage access. All
// state comes in via props: history (for the Genesis zone-coverage
// check), liveEstimate (current Monod CF/W' fit, for AUC), and
// genesisSnap (the snapshot of CF/W' captured when Genesis was
// earned, used as the AUC baseline).

import React from "react";
import { C } from "../ui/theme.js";
import { computeAUC } from "../model/monod.js";
import { zoneOf } from "../model/zones.js";

// Seven-stage badge config — thresholds are % AUC improvement above
// the Genesis snapshot. Genesis itself (threshold 0) is unlocked by
// completing one session in each zone, not by AUC.
export const BADGE_CONFIG = [
  { id: "genesis",     label: "Genesis",     emoji: "🌱", threshold: 0,   desc: "One session in every zone — the curve awakens" },
  { id: "foundation",  label: "Foundation",  emoji: "🏛️", threshold: 10,  desc: "10% above Genesis — the base is taking shape" },
  { id: "progression", label: "Progression", emoji: "📈", threshold: 22,  desc: "22% above Genesis — the model sees real upward movement" },
  { id: "momentum",    label: "Momentum",    emoji: "⚡", threshold: 37,  desc: "37% above Genesis — adaptation is compounding" },
  { id: "grind",       label: "The Grind",   emoji: "⚙️", threshold: 55,  desc: "55% above Genesis — past the easy gains" },
  { id: "threshold",   label: "Threshold",   emoji: "🔥", threshold: 75,  desc: "75% above Genesis — crossing into rare territory" },
  { id: "realization", label: "Realization", emoji: "🏔️", threshold: 100, desc: "2× your Genesis capacity — the potential fulfilled" },
];

export function BadgesView({ history, liveEstimate, genesisSnap }) {
  // Zone coverage for Genesis unlock. Bucketed by zoneOf so any
  // training within the zone counts (current 7s/45s/120s recommendations
  // and any historical 10s Power reps from the older protocol both
  // credit the right bucket).
  const hasPower    = history.some(r => zoneOf(r.target_duration) === "power");
  const hasStrength = history.some(r => zoneOf(r.target_duration) === "strength");
  const hasCapacity = history.some(r => zoneOf(r.target_duration) === "endurance");
  const genesisEarned = hasPower && hasStrength && hasCapacity;

  // AUC progress
  const genesisAUC  = genesisSnap ? computeAUC(genesisSnap.CF, genesisSnap.W) : null;
  const currentAUC  = liveEstimate ? computeAUC(liveEstimate.CF, liveEstimate.W) : null;
  const pctImprove  = (genesisAUC && currentAUC && currentAUC > genesisAUC)
    ? (currentAUC - genesisAUC) / genesisAUC * 100
    : 0;

  // Which badges are earned
  const earnedIds = new Set(
    BADGE_CONFIG
      .filter((b, i) => i === 0 ? genesisEarned : genesisEarned && pctImprove >= b.threshold)
      .map(b => b.id)
  );
  const earnedList  = BADGE_CONFIG.filter(b => earnedIds.has(b.id));
  const currentBadge= earnedList[earnedList.length - 1] ?? null;
  const nextBadge   = BADGE_CONFIG.find(b => !earnedIds.has(b.id)) ?? null;

  // Progress bar toward next badge
  const prevThr = currentBadge?.threshold ?? 0;
  const nextThr = nextBadge?.threshold ?? 100;
  const toNext  = nextBadge
    ? Math.min(100, Math.max(0, (pctImprove - prevThr) / (nextThr - prevThr) * 100))
    : 100;

  const zonesHave = [hasPower, hasStrength, hasCapacity].filter(Boolean).length;

  return (
    <div style={{ padding: "20px 16px", maxWidth: 480, margin: "0 auto" }}>

      {/* Hero: current badge */}
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <div style={{ fontSize: 56, lineHeight: 1 }}>{currentBadge?.emoji ?? "⬜"}</div>
        <div style={{ fontSize: 22, fontWeight: 800, color: C.text, marginTop: 10 }}>
          {currentBadge?.label ?? "Begin your journey"}
        </div>
        {genesisEarned && currentAUC && (
          <div style={{ fontSize: 13, color: C.muted, marginTop: 4 }}>
            {pctImprove.toFixed(1)}% above your Genesis capacity
          </div>
        )}
      </div>

      {/* Genesis checklist — shown until earned */}
      {!genesisEarned && (
        <div style={{
          background: C.card, border: `1px solid ${C.border}`,
          borderRadius: 12, padding: 16, marginBottom: 20,
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>
            Earn Genesis 🌱
          </div>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>
            Log one session in each training zone to unlock your curve.
          </div>
          {[
            { label: "Power — 10s hang",     done: hasPower },
            { label: "Strength — 45s hang",   done: hasStrength },
            { label: "Endurance — 120s hang",  done: hasCapacity },
          ].map(z => (
            <div key={z.label} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 17 }}>{z.done ? "✅" : "⬜"}</span>
              <span style={{ fontSize: 13, color: z.done ? C.green : C.muted, fontWeight: z.done ? 600 : 400 }}>
                {z.label}
              </span>
            </div>
          ))}
          <div style={{ height: 5, background: C.border, borderRadius: 3, marginTop: 12 }}>
            <div style={{
              height: "100%", borderRadius: 3, background: C.green,
              width: `${(zonesHave / 3) * 100}%`, transition: "width 0.4s",
            }} />
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>{zonesHave} of 3 zones covered</div>
        </div>
      )}

      {/* Progress toward next badge */}
      {genesisEarned && nextBadge && (
        <div style={{
          background: C.card, border: `1px solid ${C.border}`,
          borderRadius: 12, padding: 16, marginBottom: 20,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 13, color: C.muted }}>Progress to {nextBadge.emoji} {nextBadge.label}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: C.blue }}>{toNext.toFixed(0)}%</span>
          </div>
          <div style={{ height: 6, background: C.border, borderRadius: 3 }}>
            <div style={{
              height: "100%", borderRadius: 3, background: C.blue,
              width: `${toNext}%`, transition: "width 0.4s",
            }} />
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>
            Need +{nextBadge.threshold}% · you're at +{pctImprove.toFixed(1)}%
          </div>
        </div>
      )}

      {/* All-earned celebration */}
      {genesisEarned && !nextBadge && (
        <div style={{
          background: "#1a2a1a", border: `1px solid ${C.green}`,
          borderRadius: 12, padding: 16, marginBottom: 20, textAlign: "center",
        }}>
          <div style={{ fontSize: 13, color: C.green, fontWeight: 700 }}>
            🏔️ Realization achieved — you've fulfilled the potential
          </div>
        </div>
      )}

      {/* Badge pyramid — Genesis at top (origin), Realization at bottom (destination) */}
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, textAlign: "center", letterSpacing: "0.05em" }}>
        THE JOURNEY
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {BADGE_CONFIG.map((badge) => {
          const earned  = earnedIds.has(badge.id);
          const current = currentBadge?.id === badge.id;
          return (
            <div key={badge.id} style={{
              background: earned ? C.card : "transparent",
              border: `1px solid ${current ? C.blue : earned ? C.border : C.border + "50"}`,
              borderRadius: 12, padding: "12px 16px",
              display: "flex", alignItems: "center", gap: 14,
              opacity: earned ? 1 : 0.38,
              boxShadow: current ? `0 0 0 2px ${C.blue}30` : "none",
            }}>
              <span style={{ fontSize: 28, filter: earned ? "none" : "grayscale(1)" }}>
                {badge.emoji}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{
                  fontSize: 15, fontWeight: 700,
                  color: current ? C.blue : earned ? C.text : C.muted,
                  display: "flex", alignItems: "center", gap: 8,
                }}>
                  {badge.label}
                  {current && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, color: C.blue,
                      background: C.blue + "20", borderRadius: 4,
                      padding: "1px 6px", letterSpacing: "0.06em",
                    }}>NOW</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{badge.desc}</div>
              </div>
              <div style={{ fontSize: 12, color: C.muted, textAlign: "right", minWidth: 40 }}>
                {badge.threshold === 0 ? "start" : `+${badge.threshold}%`}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer note */}
      <div style={{ fontSize: 12, color: C.muted, textAlign: "center", marginTop: 20, lineHeight: 1.5 }}>
        % is AUC growth above your Genesis snapshot —<br />
        total force capacity across the 10–120s range.
      </div>
    </div>
  );
}
