// ─────────────────────────────────────────────────────────────
// CURVE COVERAGE CARD — per-zone data freshness + annual session pace
// ─────────────────────────────────────────────────────────────
// Moved from SetupView (May 2026) into AnalysisView, extracted here
// into its own file (May 2026, AnalysisView decomp pass) — same
// component, lives standalone now so it can be tested/tweaked
// without scrolling through 2500 lines of unrelated chart code.
//
// Under the curve-trust philosophy, this card surfaces where the
// curve has fresh data vs where it's extrapolating from old
// measurements. Stale zones get score-boosted in the coaching engine;
// never-trained zones tell you the curve can't be trusted there at all.
//
// Pure props/JSX — no callbacks, no side effects.

import React, { useMemo, useState } from "react";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import { ZONE_KEYS, ZONE6 } from "../../model/zones.js";
import { GRIP_COLORS } from "../../ui/grip-colors.js";
import {
  getZoneStaleness, getRollingSessionPace,
  ANNUAL_SESSION_GOAL, LOCKOUT_WINDOW_DAYS,
} from "../../model/lockout.js";

// Canonical grip order for the selector pills (matches GRIP_PRESETS).
const GRIP_ORDER = ["Crusher", "Micro", "Prime"];

// Human-readable time domain per zone, from the ZONE6 boundaries:
//   <12s · 12–50s · 50–90s · 90–140s · 140–180s · 180s+
const zoneRangeLabel = (z) =>
  !isFinite(z.max) ? `${z.min}s+`
  : z.min === 0    ? `<${z.max}s`
  :                  `${z.min}–${z.max}s`;
const ZONE_RANGE = Object.fromEntries(ZONE6.map(z => [z.key, zoneRangeLabel(z)]));

export function CurveCoverageCard({ history }) {
  // Per-grip coverage: zone freshness is grip-specific (a fresh Crusher
  // zone says nothing about Micro — the two grips train different
  // muscles), so a pill always picks ONE grip. There is no pooled "All"
  // view: pooling zone freshness across muscle groups is misleading.
  // Defaults to the first present grip. The annual session pace below
  // stays overall — it's a training-frequency stat, not grip-specific.
  const [selGrip, setSelGrip] = useState(null);
  const presentGrips = useMemo(() => {
    const set = new Set((history || []).map(r => r?.grip).filter(Boolean));
    const ordered = GRIP_ORDER.filter(g => set.has(g));
    for (const g of set) if (!ordered.includes(g)) ordered.push(g);  // keep unknowns
    return ordered;
  }, [history]);
  // Effective grip: the user's pick if still present, else the first
  // present grip. Never "all".
  const activeGrip = (selGrip && presentGrips.includes(selGrip))
    ? selGrip
    : (presentGrips[0] || null);
  const gripHistory = useMemo(
    () => (activeGrip ? (history || []).filter(r => r?.grip === activeGrip) : (history || [])),
    [history, activeGrip]
  );
  const staleness = useMemo(() => getZoneStaleness(gripHistory), [gripHistory]);
  const pace = useMemo(() => getRollingSessionPace(history), [history]);

  if (pace.current === 0) return null;

  const STATUS_ORDER = { stale: 0, warning: 1, never: 2, ok: 3 };
  const STATUS_LABEL = {
    stale:   { color: C.red,    text: "stale"    },
    warning: { color: C.orange, text: "soon"     },
    // "never" was visually alarming — neutral "modeled" reflects that
    // the curve is extrapolated from adjacent zones, which is not
    // automatically a problem when those neighbors are well-sampled.
    // The recommendation engine knows when extrapolation actually
    // hurts (low data confidence + below-curve neighbors) and asks
    // for a sample then; the card stays descriptive, not demanding.
    never:   { color: C.muted,  text: "modeled"  },
    ok:      { color: C.green,  text: "fresh"    },
  };
  const sortedZones = [...ZONE_KEYS].sort((a, b) => {
    const sa = STATUS_ORDER[staleness[a].status];
    const sb = STATUS_ORDER[staleness[b].status];
    if (sa !== sb) return sa - sb;
    return ZONE_KEYS.indexOf(a) - ZONE_KEYS.indexOf(b);
  });

  const counts = sortedZones.reduce((acc, k) => {
    acc[staleness[k].status] = (acc[staleness[k].status] || 0) + 1;
    return acc;
  }, {});
  const staleCount   = counts.stale   || 0;
  const warningCount = counts.warning || 0;
  const neverCount   = counts.never   || 0;

  // Pace = projection over the next 365 days at the current rate. For
  // mature users (≥1 year of history) this equals `pace.current` and
  // the second line is just confirmation; for newer users it's the
  // extrapolated forecast. Hide the projection line when the two
  // numbers match to avoid the redundant "26 of 100 next 12 months"
  // restating "26 / 100 last 12 months."
  const onPace      = pace.paceYearEnd >= ANNUAL_SESSION_GOAL;
  const paceColor   = onPace ? C.green
                    : pace.paceYearEnd >= ANNUAL_SESSION_GOAL * 0.8 ? C.orange
                    : C.red;
  const showPaceLine = pace.paceYearEnd !== pace.current;

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Curve Coverage</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
            Where your data is fresh
          </div>
        </div>
        <div style={{ fontSize: 11, color: C.muted, textAlign: "right" }}>
          <div>
            <b style={{ color: showPaceLine ? C.text : paceColor }}>
              {pace.current}
            </b>
            {" / "}{ANNUAL_SESSION_GOAL} last 12 months
          </div>
          {showPaceLine && (
            <div style={{ color: paceColor, marginTop: 2 }}>
              on pace for {pace.paceYearEnd} next 12 months
            </div>
          )}
        </div>
      </div>

      {/* Grip selector — coverage is per-grip (no pooled "All": the
          grips train different muscles, so pooled freshness is
          misleading). Hidden when only one grip has data. */}
      {presentGrips.length > 1 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
          {presentGrips.map(g => {
            const active = activeGrip === g;
            const color = GRIP_COLORS[g] || C.blue;
            return (
              <button
                key={g}
                onClick={() => setSelGrip(g)}
                style={{
                  padding: "4px 12px", borderRadius: 999, fontSize: 12, fontWeight: 600,
                  cursor: "pointer",
                  border: `1px solid ${active ? color : C.border}`,
                  background: active ? `${color}22` : "transparent",
                  color: active ? color : C.muted,
                }}
              >
                {g}
              </button>
            );
          })}
        </div>
      )}

      {/* Alarm box: only for stale or aging zones — those are real
          training debts. "Never sampled" is reported descriptively
          below (the modeled badge) rather than flagged as a problem;
          when neighboring zones are well-sampled the curve there is
          still a credible extrapolation, and the engine handles
          prioritization on its own. */}
      {(staleCount > 0 || warningCount > 0) && (
        <div style={{
          padding: "8px 10px", marginBottom: 12,
          background: C.bg, borderRadius: 8,
          border: `1px solid ${staleCount > 0 ? C.red : C.orange}40`,
          fontSize: 11, color: C.muted, lineHeight: 1.5,
        }}>
          {staleCount > 0 && (
            <div>
              <span style={{ color: C.red, fontWeight: 700 }}>● {staleCount} stale</span>
              {warningCount > 0 ? " · " : ""}
            </div>
          )}
          {warningCount > 0 && (
            <div>
              <span style={{ color: C.orange, fontWeight: 700 }}>● {warningCount} aging</span>
            </div>
          )}
          <div style={{ marginTop: 4, fontStyle: "italic" }}>
            Past the detraining window — the engine will prioritize a fresh sample.
          </div>
        </div>
      )}
      {/* Neutral coverage summary when there are modeled-only zones
          and no stale/aging ones. Information without alarm. */}
      {neverCount > 0 && staleCount === 0 && warningCount === 0 && (
        <div style={{
          padding: "8px 10px", marginBottom: 12,
          background: C.bg, borderRadius: 8,
          border: `1px solid ${C.border}`,
          fontSize: 11, color: C.muted, lineHeight: 1.5,
        }}>
          {ZONE_KEYS.length - neverCount} of {ZONE_KEYS.length} zones have direct samples. The remaining {neverCount === 1 ? "zone uses" : `${neverCount} zones use`} curve extrapolation from neighboring data — fine when neighbors are well-sampled.
        </div>
      )}

      <div>
        {sortedZones.map(k => {
          const s = staleness[k];
          const cfg = STATUS_LABEL[s.status];
          const window = LOCKOUT_WINDOW_DAYS[k];
          const daysText = s.days == null
            ? "modeled from neighbors"
            : s.days === 0
              ? "today"
              : s.days === 1
                ? "1 day ago"
                : `${s.days} days ago`;
          return (
            <div key={k} style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "6px 0",
              borderBottom: `1px solid ${C.border}`,
            }}>
              <div style={{ fontSize: 12, color: C.text }}>
                {k.replace(/_/g, " · ").replace(/\b\w/g, c => c.toUpperCase())}
                <span style={{ color: C.muted, fontSize: 11, marginLeft: 6, fontVariantNumeric: "tabular-nums" }}>
                  {ZONE_RANGE[k]}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 11, color: C.muted, fontVariantNumeric: "tabular-nums" }}>
                  {daysText}
                </span>
                <span style={{
                  fontSize: 9, fontWeight: 700, color: cfg.color,
                  background: `${cfg.color}1a`,
                  padding: "2px 6px", borderRadius: 4,
                  textTransform: "uppercase", letterSpacing: 0.5,
                  whiteSpace: "nowrap",
                }}>
                  {cfg.text} · {window}d
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
