import React from 'react';
import { C } from '../../ui/theme.js';
import { GRIP_COLORS } from '../../ui/grip-colors.js';
import { fmtW } from '../../ui/format.js';
import { CHART } from '../../ui/chartStyles.js';
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
  return <g>{symbol}{payload.extrapolated && <circle cx={cx} cy={cy} r={radius + 3}
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
  const { date, grip, hand, force, expectedForce, duration, deviation, context, earlierGrips,
    recordingCompatibility, expectationSource, calibrationScale, modelDurationRange, extrapolated } = observation;
  const percent = formatTrendPercent(deviation);
  return <section className="trend-point-details" aria-label="Selected opening hold">
    <h4 style={{ color: GRIP_COLORS[grip] || C.blue }}>{grip} · {handLabel(hand)} · {date}</h4>
    <strong>{percent} versus expected force</strong>
    <dl>
      <dt>Measured average force</dt><dd>{fmtW(force, unit)} {unit}</dd>
      <dt>Calibrated expected force</dt><dd>{fmtW(expectedForce, unit)} {unit}</dd>
      <dt>Comparable hold duration</dt><dd>{durationText(duration)}</dd>
      <dt>Expectation source</dt><dd>{expectationSource === 'frozen'
        ? 'Saved before this workout' : 'Reconstructed from earlier history'}</dd>
      <dt>Finger session order</dt><dd>{CONTEXT_LABELS[context] || CONTEXT_LABELS.unknown}</dd>
    </dl>
    {Number.isFinite(calibrationScale) && <p>Personal calibration applied: {calibrationScale.toFixed(2)}×.</p>}
    {extrapolated && <p>The achieved duration sits outside the previously measured range
      {modelDurationRange ? ` (${durationText(modelDurationRange.min)}–${durationText(modelDurationRange.max)})` : ''}. The point is shown with an extrapolation ring rather than discarded.</p>}
    {earlierGrips?.length > 0 && <p>Earlier recorded finger training: {earlierGrips.join(', ')}.</p>}
    <p>{context === 'after_training'
      ? 'Earlier finger training is recorded. Its effect on this hold is unknown.'
      : context === 'first_recorded'
        ? 'First recorded does not establish recovery; earlier or recent climbing may be missing.'
        : 'The records do not establish this session’s order or your recovery.'}</p>
    {recordingCompatibility && <p>{recordingCompatibility}</p>}
    <p>A negative percentage means force below the calibrated pre-session curve at this duration. It is not a percentage loss of maximum strength.</p>
  </section>;
}

export function PerformancePointTooltip({ observation, unit = 'kg' }) {
  if (!observation) return null;
  return <div role="tooltip" style={{ ...CHART.tooltip, padding: 12 }}><PerformanceObservationDetails observation={observation} unit={unit} /></div>;
}

export function OpeningHoldInspector({ observations, unit = 'kg', selectedId, onSelect, open, onToggle }) {
  const selected = observations.find(item => String(item.id) === selectedId) || observations.at(-1);
  if (!selected) return null;
  return <details open={open} style={{ marginTop: 8, marginBottom: 0 }}>
    <summary onClick={event => { event.preventDefault(); onToggle(!open); }} style={{ cursor: 'pointer', fontSize: 14, color: C.muted, padding: '12px 0', lineHeight: '20px' }}>Inspect opening-hold measurements</summary>
    <label className="trend-filter" style={{ marginBottom: 14 }}>Opening hold
      <select value={String(selected.id)} onChange={event => onSelect(event.target.value)}>
        {[...observations].reverse().map(item => <option value={String(item.id)} key={item.id}>
          {item.date} · {item.grip} · {handLabel(item.hand)} · {durationText(item.duration)} · {formatTrendPercent(item.deviation)}
        </option>)}
      </select>
    </label>
    <PerformanceObservationDetails observation={selected} unit={unit} />
  </details>;
}
