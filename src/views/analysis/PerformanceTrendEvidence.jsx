import React, { useState } from 'react';
import { C } from '../../ui/theme.js';
import { Disclosure } from '../../ui/components.jsx';
import { GRIP_COLORS } from '../../ui/grip-colors.js';
import { fmtW } from '../../ui/format.js';
import { CHART } from '../../ui/chartStyles.js';
import { PERFORMANCE_REFERENCE_DURATIONS, DURATION_BAND_LABELS } from '../../model/performanceTrendEvidence.js';

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
const supportCount = evidence => evidence?.referenceSupport?.filter(item => item.status === 'supported').length ?? 0;

export function CapacitySummaries({ summaries }) {
  return <div className="trend-summary-grid">
    {summaries.map(({ grip, latest, hasHistoricalEstimate }) => <section key={grip} className="trend-summary" aria-label={`${grip} capacity summary`}>
      <h4 style={{ color: GRIP_COLORS[grip] || C.blue }}>{grip}</h4>
      {!latest ? <p className="trend-small">{hasHistoricalEstimate
        ? 'No capacity estimate for this grip falls within the shown range.'
        : 'A starting reference is not available for the selected hand view yet.'}</p> : <>
        <div className="trend-summary-date">Latest shown estimate · <time dateTime={latest.date}>{latest.date}</time></div>
        <dl className="trend-summary-values">
          <div><dt>Since starting reference</dt><dd>{formatTrendPercent(latest.change)}
            <time dateTime={latest.evidence.baselineDate}>{latest.evidence.baselineDate}</time>
          </dd></div>
          <div><dt>From highest estimate</dt><dd>{formatTrendPercent(latest.evidence.changeFromPeak)}
            <time dateTime={latest.evidence.peakDate}>{latest.evidence.peakDate}</time>
          </dd></div>
        </dl>
        {latest.evidence.baselineEvidence?.status === 'provisional' && <div className="trend-support-label">
          Starting reference: provisional
        </div>}
        {latest.evidence.currentEvidence?.status === 'limited' && <div className="trend-small">
          Latest estimate: limited duration coverage
        </div>}
      </>}
    </section>)}
  </div>;
}

function DurationCell({ summary, duration, comparison }) {
  const latest = summary.latest?.evidence;
  const current = latest?.referenceForces?.find(item => item.duration === duration);
  const reference = comparison === 'range'
    ? summary.first?.evidence.referenceForces?.find(item => item.duration === duration)
    : null;
  const referenceForce = comparison === 'range' ? reference?.force : current?.peakForce;
  const change = Number.isFinite(current?.force) && referenceForce > 0 ? (current.force / referenceForce - 1) * 100 : null;
  const limited = current?.currentSupport !== 'supported'
    || (comparison === 'range' ? reference?.currentSupport !== 'supported' : current?.peakSupport !== 'supported');
  return <td>
    {formatTrendPercent(change)}
    {Number.isFinite(change) && limited && <span className="trend-limited" title="Fewer than two training dates near this duration in at least one comparison estimate.">Limited support</span>}
  </td>;
}

export function DurationBreakdown({ summaries }) {
  const [comparison, setComparison] = useState('peak');
  const available = summaries.filter(summary => summary.latest);
  if (!available.length) return null;
  return <section className="trend-subsection" aria-label="Capacity by hold duration">
    <h4>Where the estimate changed</h4>
    <p className="trend-small">Changes in predicted force at fixed hold durations. These estimates come from the same curve as the chart.</p>
    <div className="trend-filters">
      <label className="trend-filter">Compare latest shown estimate with
        <select value={comparison} onChange={event => setComparison(event.target.value)}>
          <option value="peak">Highest whole-curve estimate</option>
          <option value="range">First estimate in shown range</option>
        </select>
      </label>
    </div>
    <table className="trend-duration-table">
      <caption>
        {available.map((summary, index) => <React.Fragment key={summary.grip}>
          {index > 0 && <br />}
          {summary.grip}: {comparison === 'range' ? summary.first?.date : summary.latest.evidence.peakDate} → {summary.latest.date}
        </React.Fragment>)}
      </caption>
      <thead><tr><th scope="col">Hold</th>{available.map(({ grip }) => <th scope="col" key={grip} style={{ color: GRIP_COLORS[grip] || C.blue }}>{grip}</th>)}</tr></thead>
      <tbody>{PERFORMANCE_REFERENCE_DURATIONS.map(duration => <tr key={duration}>
        <th scope="row">{duration} s</th>
        {available.map(summary => <DurationCell key={summary.grip} summary={summary} duration={duration} comparison={comparison} />)}
      </tr>)}</tbody>
    </table>
    <p className="trend-small">Limited support means fewer than two training dates near that duration in one or both comparison estimates, for at least one selected hand. Coverage includes older measurements; it is not a recent-coverage or statistical-confidence test.</p>
  </section>;
}

function EvidenceDetails({ title, date, evidence }) {
  if (!evidence) return null;
  return <section className="trend-evidence">
    <h4>{title} · {date}</h4>
    <p>{evidence.status === 'provisional' ? 'Provisional reference. ' : ''}
      Repeated local measurements support {supportCount(evidence)} of 6 reference durations.
    </p>
    {evidence.perHand?.map(item => <p key={item.hand}>
      <b>{handLabel(item.hand)}:</b> {item.eligibleDates} eligible training dates
      {item.durationRange && <> · observed holds {durationText(item.durationRange.min)} to {durationText(item.durationRange.max)}</>}
    </p>)}
    {evidence.perHand?.length > 0 && <table className="trend-duration-table">
      <caption>Last nearby measurement by hold duration</caption>
      <thead><tr><th scope="col">Hold</th>{evidence.perHand.map(item => <th scope="col" key={item.hand}>{handLabel(item.hand)}</th>)}</tr></thead>
      <tbody>{PERFORMANCE_REFERENCE_DURATIONS.map(duration => <tr key={duration}>
        <th scope="row">{duration} s</th>
        {evidence.perHand.map(item => {
          const local = item.referenceSupport?.find(support => support.duration === duration);
          return <td key={item.hand}>{local?.lastDate || 'None'}
            {local?.dates > 0 && <span className="trend-small" style={{ display: 'block', fontSize: 10 }}>{local.dates} {local.dates === 1 ? 'date' : 'dates'} total</span>}
          </td>;
        })}
      </tr>)}</tbody>
    </table>}
    {evidence.reasons?.length > 0 && <ul>{evidence.reasons.filter(reason => reason !== evidence.stability?.reason).map(reason => <li key={reason}>{reason}</li>)}</ul>}
    {evidence.recordingMethods?.length > 0 && <p>Recording methods: {evidence.recordingMethods.map(method => method.label).join('; ')}.</p>}
    {evidence.stability?.status === 'insufficient' && <p>
      Reference stability has not been established. {evidence.stability.reason}
    </p>}
    {evidence.stability?.status === 'available' && <p>
      Removing one training date at a time changed the starting estimate by {formatTrendPercent(evidence.stability.changeRange?.[0])} to {formatTrendPercent(evidence.stability.changeRange?.[1])}. This sensitivity check is not a confidence interval.
    </p>}
  </section>;
}

export function CapacityEvidenceDetails({ summaries }) {
  const available = summaries.filter(summary => summary.latest);
  if (!available.length) return null;
  return <Disclosure title="Starting reference and data coverage" style={{ marginTop: 8, marginBottom: 0 }}>
    <p className="trend-small">The first fitted comparison starts after five eligible training dates per hand. That does not guarantee coverage across the full duration range. A provisional starting reference stays marked according to the evidence available when it was set.</p>
    {available.map(({ grip, latest }) => <section key={grip} aria-label={`${grip} reference evidence`}>
      <h4 style={{ color: GRIP_COLORS[grip] || C.blue, marginBottom: 0, fontSize: 13 }}>{grip}</h4>
      <EvidenceDetails title="Starting reference" date={latest.evidence.baselineDate} evidence={latest.evidence.baselineEvidence} />
      <EvidenceDetails title="Latest shown estimate" date={latest.date} evidence={latest.evidence.currentEvidence} />
    </section>)}
    <p className="trend-small">Local support counts all eligible training dates through each estimate, including older measurements, within 25% of each reference duration or 3 seconds for the shortest holds. It is a descriptive coverage guide, not a recent-coverage or statistical-confidence test. Coverage cannot establish recovery or consistent effort.</p>
  </Disclosure>;
}

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
  return <g>{symbol}</g>;
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
    </ul>
  </>;
}

export function PerformanceObservationDetails({ observation, unit = 'kg' }) {
  if (!observation) return null;
  const { date, grip, hand, force, expectedForce, duration, deviation, context, earlierGrips, recordingCompatibility } = observation;
  const percent = formatTrendPercent(deviation);
  return <section className="trend-point-details" aria-label="Selected opening hold">
    <h4 style={{ color: GRIP_COLORS[grip] || C.blue }}>{grip} · {handLabel(hand)} · {date}</h4>
    <strong>{percent} versus expected force</strong>
    <dl>
      <dt>Measured average force</dt><dd>{fmtW(force, unit)} {unit}</dd>
      <dt>Expected average force</dt><dd>{fmtW(expectedForce, unit)} {unit}</dd>
      <dt>Comparable hold duration</dt><dd>{durationText(duration)}</dd>
      <dt>Finger session order</dt><dd>{CONTEXT_LABELS[context] || CONTEXT_LABELS.unknown}</dd>
    </dl>
    {earlierGrips?.length > 0 && <p>Earlier recorded finger training: {earlierGrips.join(', ')}.</p>}
    <p>{context === 'after_training'
      ? 'Earlier finger training is recorded. Its effect on this hold is unknown.'
      : context === 'first_recorded'
        ? 'First recorded does not establish recovery; earlier or recent climbing may be missing.'
        : 'The records do not establish this session’s order or your recovery.'}</p>
    {recordingCompatibility && <p>{recordingCompatibility}</p>}
    <p>A negative percentage means force below the prior curve at this duration. It is not a percentage loss of maximum strength.</p>
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
