import React from 'react';
import { C } from '../../ui/theme.js';
import { GRIP_COLORS } from '../../ui/grip-colors.js';
import { fmtW } from '../../ui/format.js';
import { DURATION_BAND_LABELS } from '../../model/performanceTrendEvidence.js';

const handLabel = hand => hand === 'L' ? 'Left' : hand === 'R' ? 'Right' : hand;
export const CONTEXT_LABELS = {
  first_recorded: 'First recorded finger session',
  after_training: 'After earlier finger training',
  unknown: 'Session order unknown',
};
export const BAND_LABELS = DURATION_BAND_LABELS;

export function formatTrendPercent(value) {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.abs(value) < .05 ? 0 : value;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}%`;
}

const durationText = value => Number.isFinite(value) ? `${Number(value.toFixed(1))} s` : 'Unknown';

export function PerformancePointGlyph({ cx = 9, cy = 9, payload = {}, fill = C.blue, radius = 4.5 }) {
  const context = payload.context || 'unknown';
  const props = {
    fill: context === 'first_recorded' ? fill : C.card,
    stroke: fill,
    strokeWidth: context === 'first_recorded' ? 1.4 : 2,
    strokeDasharray: context === 'unknown' ? '2 2' : undefined,
  };
  const symbol = payload.durationBand === 'long'
    ? <path d={`M ${cx} ${cy - radius - 1} L ${cx + radius + 1} ${cy + radius} L ${cx - radius - 1} ${cy + radius} Z`} {...props} />
    : payload.durationBand === 'medium'
      ? <rect x={cx - radius} y={cy - radius} width={radius * 2} height={radius * 2} {...props} />
      : <circle cx={cx} cy={cy} r={radius} {...props} />;
  return <g className="trend-point-glyph">{symbol}{payload.extrapolated && <circle cx={cx} cy={cy} r={radius + 3}
    fill="none" stroke={fill} strokeWidth="1.2" strokeDasharray="2 2" />}</g>;
}

export function PerformancePointLegend({ grips }) {
  return <>
    <ul className="trend-point-legend" aria-label="Grip colors">
      {grips.map(grip => <li key={grip}><svg width="18" height="18" aria-hidden="true"><PerformancePointGlyph fill={GRIP_COLORS[grip] || C.blue} payload={{ context: 'first_recorded' }} /></svg>{grip}</li>)}
      <li><svg width="18" height="18" aria-hidden="true"><rect x="6" y="3" width="6" height="12" fill={C.orange} opacity=".6" /></svg>Logged climbing load (0–10)</li>
    </ul>
    <ul className="trend-point-legend" aria-label="Hold duration symbols">
      {Object.entries(BAND_LABELS).map(([band, label]) => <li key={band}>
        <svg width="18" height="18" aria-hidden="true"><PerformancePointGlyph fill={C.muted} payload={{ durationBand: band, context: 'first_recorded' }} /></svg>{label}
      </li>)}
    </ul>
    <ul className="trend-point-legend" aria-label="Finger session order symbols">
      {Object.entries(CONTEXT_LABELS).map(([context, label]) => <li key={context}>
        <svg width="18" height="18" aria-hidden="true"><PerformancePointGlyph fill={C.muted} payload={{ context }} /></svg>{label}
      </li>)}
      <li><svg width="18" height="18" aria-hidden="true"><PerformancePointGlyph fill={C.muted}
        payload={{ context: 'first_recorded', extrapolated: true }} /></svg>Outside prior duration range</li>
    </ul>
  </>;
}

export function PerformanceObservationDetails({ observation, unit = 'kg' }) {
  if (!observation) return null;
  const { date, grip, hand, force, expectedForce, duration, deviation, context,
    expectationBasis, plannedLoad, plannedDuration } = observation;
  const percent = formatTrendPercent(deviation);
  return <section className="trend-point-details" aria-label="Selected opening hold">
    <h4 style={{ color: GRIP_COLORS[grip] || C.blue }}>{grip} · {handLabel(hand)} · {date}</h4>
    <strong>{percent} versus predicted force</strong>
    <dl>
      <dt>Measured average force</dt><dd>{fmtW(force, unit)} {unit}</dd>
      <dt>Predicted force</dt><dd>{fmtW(expectedForce, unit)} {unit}</dd>
      <dt>Comparable hold duration</dt><dd>{durationText(duration)}</dd>
      {expectationBasis === 'workout_plan' && <>
        <dt>Workout target</dt><dd>{fmtW(plannedLoad, unit)} {unit} for {durationText(plannedDuration)}</dd>
      </>}
      <dt>Finger session order</dt><dd>{CONTEXT_LABELS[context] || CONTEXT_LABELS.unknown}</dd>
    </dl>
  </section>;
}
