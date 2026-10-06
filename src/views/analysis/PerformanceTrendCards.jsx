import React, { useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Line, Bar, Scatter, XAxis, YAxis,
  Tooltip, CartesianGrid, ReferenceLine,
} from 'recharts';
import { ChartLegend } from '../../ui/ChartLegend.jsx';
import { CHART } from '../../ui/chartStyles.js';
import { Card, CardTitle, Disclosure } from '../../ui/components.jsx';
import { C } from '../../ui/theme.js';
import { GRIP_COLORS } from '../../ui/grip-colors.js';
import { DateRangeSlider, normalizeHistoryWindow } from '../../ui/DateRangeSlider.jsx';
import { DEFAULT_PERFORMANCE_TREND_MODEL } from '../../model/performanceTrends.js';
import { buildPerformanceTrendAnalysis } from '../../model/performanceTrendEvidence.js';
import { suggestCookedFromClimbs } from '../../model/climbingFatigue.js';
import {
  BAND_LABELS, CONTEXT_LABELS, CapacitySummaries, DurationBreakdown,
  CapacityEvidenceDetails, PerformancePointGlyph, PerformancePointLegend,
  PerformancePointTooltip, OpeningHoldInspector, formatTrendPercent,
} from './PerformanceTrendEvidence.jsx';
import './PerformanceTrendCards.css';

const EMPTY = [];
const fmtDate = timestamp => new Date(timestamp).toISOString().slice(5, 10);
const shortDomain = ([low, high]) => {
  const span = Math.max(5, Math.abs(low || 0), Math.abs(high || 0));
  return [-Math.ceil(span), Math.ceil(span)];
};
const longDomain = ([low, high]) => [Math.min(-5, (low || 0) - 1), Math.max(5, (high || 0) + 1)];
const cardStyle = { marginBottom: 16, padding: '20px clamp(14px, 4vw, 24px)', minWidth: 0 };

function CapacityTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const labelDate = new Date(label);
  const date = payload[0]?.payload?.date || (Number.isFinite(labelDate.getTime()) ? labelDate.toISOString().slice(0, 10) : '');
  return <div style={{ ...CHART.tooltip, padding: 12 }}>
    <b>{date}</b>
    {payload.map(item => <div key={item.dataKey} style={{ marginTop: 4, color: item.color }}>
      {item.name}: {item.dataKey === 'climbLoad' ? `${item.value}/10` : `${formatTrendPercent(item.value)} since starting reference`}
    </div>)}
  </div>;
}

export function PerformanceTrendCards({
  history = EMPTY, grips = EMPTY, handView = 'pooled', activities = EMPTY,
  normalizeOn = false, trendModel = DEFAULT_PERFORMANCE_TREND_MODEL, unit = 'kg',
}) {
  const selectedGrips = grips || EMPTY;
  // Refit only when source history or model scope changes. Date and point
  // filters expose a view of the historical estimates; they never rebase them.
  const analysis = useMemo(
    () => buildPerformanceTrendAnalysis(history, selectedGrips, handView, { model: trendModel }),
    [history, selectedGrips, handView, trendModel],
  );
  const rows = analysis.rows || EMPTY;
  const observations = analysis.observations || EMPTY;
  const [window, setWindow] = useState(null);
  const [durationBand, setDurationBand] = useState('all');
  const [sessionContext, setSessionContext] = useState('all');
  const [hoveredId, setHoveredId] = useState(null);
  const [selectedObservationId, setSelectedObservationId] = useState(null);
  const [inspectOpen, setInspectOpen] = useState(false);
  const dates = rows.map(row => row.date);
  const firstMatch = window ? dates.findIndex(date => date >= window[0]) : 0;
  const first = firstMatch < 0 ? dates.length - 1 : firstMatch;
  const last = window ? dates.findLastIndex(date => date <= window[1]) : dates.length - 1;
  const [start, end] = normalizeHistoryWindow(first, Math.max(first, last), dates.length - 1);
  const startDate = dates[start], endDate = dates[end];
  const visible = useMemo(() => rows.slice(start, end + 1).map(row => ({
    ...row, climbLoad: suggestCookedFromClimbs(activities, row.date)?.cooked ?? null,
  })), [rows, start, end, activities]);
  // Scatter series may begin later or include several holds on the same date.
  // Keep the common date window and tick list independent of their density.
  const dateTicks = [...new Set(visible.map(row => row.timestamp))];
  const dateDomain = [dateTicks[0], dateTicks.at(-1)];
  const inRangeObservations = useMemo(
    () => observations.filter(item => item.date >= startDate && item.date <= endDate),
    [observations, startDate, endDate],
  );
  const visibleObservations = useMemo(() => inRangeObservations.filter(item =>
    (durationBand === 'all' || item.durationBand === durationBand)
    && (sessionContext === 'all' || item.context === sessionContext)),
  [inRangeObservations, durationBand, sessionContext]);
  const observationSeries = useMemo(() => selectedGrips.map(grip => ({
    grip, observations: visibleObservations.filter(item => item.grip === grip),
  })).filter(series => series.observations.length > 0), [selectedGrips, visibleObservations]);
  const hoveredObservation = visibleObservations.find(item => String(item.id) === hoveredId);
  const summaries = useMemo(() => selectedGrips.map(grip => {
    const estimates = visible.filter(row => Number.isFinite(row[`${grip}_long`]) && row[`${grip}_evidence`])
      .map(row => ({ date: row.date, change: row[`${grip}_long`], evidence: row[`${grip}_evidence`] }));
    return { grip, first: estimates[0], latest: estimates.at(-1), hasHistoricalEstimate: rows.some(row => row[`${grip}_evidence`]) };
  }), [visible, rows, selectedGrips]);
  const hasLong = visible.some(row => selectedGrips.some(grip => Number.isFinite(row[`${grip}_long`])));
  const laterHolds = inRangeObservations.filter(item => item.context === 'after_training').length;

  if (!rows.length) return <section className="performance-trends" aria-label="Performance trends">
    <Card style={cardStyle}>
      <CardTitle>Estimated finger capacity over time</CardTitle>
      <p className="trend-intro">More training dates needed. A first estimate needs five eligible training dates per selected hand. Both-hand estimates require a curve for each hand. Try Left or Right above if only one hand has enough history.</p>
      <p className="trend-small">The starting reference will remain provisional where duration coverage is limited. Missing estimates do not indicate declining performance.</p>
    </Card>
    <Card style={cardStyle}>
      <CardTitle>Session performance versus expected curve</CardTitle>
      <p className="trend-intro">Opening-hold comparisons appear once a prior curve is available and the hold falls within previously measured durations.</p>
    </Card>
  </section>;

  return <section className="performance-trends" aria-label="Performance trends">
    <Card style={cardStyle}>
      <CardTitle>Estimated finger capacity over time</CardTitle>
      <p className="trend-intro">Modeled force across six hold durations, compared with your starting reference. This describes finger-training estimates; climbing performance and recovery need their own context.</p>
      <CapacitySummaries summaries={summaries} />
      <p className="trend-small">The highest estimate is the highest whole-curve score reached by each grip’s latest shown date, including dates before the shown range.</p>
      {hasLong ? <div className="trend-chart" role="img" aria-label="Estimated capacity change from the starting reference, by date and grip">
        <ResponsiveContainer width="100%" height={CHART.height}>
          <ComposedChart data={visible} margin={CHART.margin}>
            <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
            <XAxis type="number" dataKey="timestamp" domain={dateDomain} ticks={dateTicks} interval="preserveStartEnd" scale="time" tickFormatter={fmtDate} tick={CHART.tick} minTickGap={32} />
            <YAxis yAxisId="trend" unit="%" width={52} tickFormatter={value => Number(value.toFixed(1))} tick={CHART.tick} domain={longDomain} />
            <YAxis yAxisId="climb" domain={[0, 40]} orientation="right" width={0} hide />
            <ReferenceLine yAxisId="trend" y={0} stroke={C.muted} strokeDasharray="5 5" />
            <Tooltip content={<CapacityTooltip />} />
            <Bar yAxisId="climb" dataKey="climbLoad" name="Logged climbing load" fill={C.orange} opacity={.4} barSize={6} isAnimationActive={false} />
            {selectedGrips.map(grip => <Line key={grip} yAxisId="trend" dataKey={`${grip}_long`} name={grip} stroke={GRIP_COLORS[grip] || C.blue}
              strokeWidth={3} dot={{ r: 3 }} connectNulls type="linear" isAnimationActive={false} />)}
          </ComposedChart>
        </ResponsiveContainer>
      </div> : <p className="trend-small">No capacity estimates in this range for the selected hands. A single-hand view may have more evidence.</p>}
      <ChartLegend items={[
        ...selectedGrips.map(grip => ({ label: grip, color: GRIP_COLORS[grip] || C.blue })),
        { label: 'Logged climbing load (0–10)', color: C.orange, kind: 'bar' },
      ]} />
      <DateRangeSlider dates={dates} start={start} end={end} onChange={(a, b) => setWindow([dates[a], dates[b]])} />
      <DurationBreakdown summaries={summaries} />
      <CapacityEvidenceDetails summaries={summaries} />
      <Disclosure title="How to read the estimates" style={{ marginTop: 8, marginBottom: 0 }}>
        <p className="trend-small">Each date uses the training recorded by that date. Older training gradually receives less weight with a 90-day half-life. Both-hand capacity weights the hands equally. A smooth fitted line does not establish a change in rested capacity.</p>
        {trendModel !== 'original' && <p className="trend-small">Sessions after earlier finger training that day receive less weight, including training on another grip. This does not correct for climbing or accumulated fatigue.</p>}
        {trendModel === 'contextRobust' && <p style={{ color: C.yellow, fontSize: 12 }}>Research preview: unusually high and low results also have reduced influence. This additional smoothing is experimental.</p>}
        <p className="trend-small">Orange bars show estimated load from logged climbing on that date and the previous day, on a separate 0–10 scale. A score of 10 fills the bottom quarter of the chart. Same-day climbing may have happened before or after finger training.</p>
      </Disclosure>
      {normalizeOn && <p className="trend-small">These estimates use absolute measured force. The bodyweight toggle applies to the other curve charts.</p>}
    </Card>
    <Card style={cardStyle}>
      <CardTitle>Session performance versus expected curve</CardTitle>
      <p className="trend-intro">Each point is one opening hold compared with the curve available before that day, at the same duration. −20% means 20% less force than expected for that hold, not a 20% loss of maximum strength.</p>
      <div className="trend-filters">
        <label className="trend-filter">Hold duration
          <select value={durationBand} onChange={event => setDurationBand(event.target.value)}>
            <option value="all">All hold durations</option>
            {Object.entries(BAND_LABELS).map(([key, label]) => <option value={key} key={key}>{label}</option>)}
          </select>
        </label>
        <label className="trend-filter">Finger session order
          <select value={sessionContext} onChange={event => setSessionContext(event.target.value)}>
            <option value="all">All recorded session orders</option>
            {Object.entries(CONTEXT_LABELS).map(([key, label]) => <option value={key} key={key}>{label}</option>)}
          </select>
        </label>
      </div>
      <p className="trend-small" aria-live="polite">Showing {visibleObservations.length} of {inRangeObservations.length} comparable opening holds in this date range.</p>
      {visibleObservations.length ? <div className="trend-chart trend-point-chart" role="img" aria-label="Individual opening holds compared with expected force, shown as unconnected points">
        <ResponsiveContainer width="100%" height={CHART.height}>
          <ComposedChart data={visible} margin={CHART.margin}>
            <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
            <XAxis type="number" dataKey="timestamp" domain={dateDomain} ticks={dateTicks} interval="preserveStartEnd" scale="time" tickFormatter={fmtDate} tick={CHART.tick} minTickGap={32} />
            <YAxis yAxisId="trend" type="number" dataKey="deviation" unit="%" width={52} tickFormatter={value => Number(value.toFixed(1))} tick={CHART.tick} domain={shortDomain} />
            <YAxis yAxisId="climb" domain={[0, 40]} orientation="right" width={0} hide />
            <ReferenceLine yAxisId="trend" y={0} stroke={C.muted} strokeDasharray="5 5" />
            <Bar yAxisId="climb" dataKey="climbLoad" name="Logged climbing load" fill={C.orange} opacity={.4} barSize={6} isAnimationActive={false} />
            {observationSeries.map(({ grip, observations: gripObservations }) => <Scatter key={grip} yAxisId="trend" dataKey="deviation" name={grip}
              data={gripObservations} fill={GRIP_COLORS[grip] || C.blue}
              onMouseEnter={point => setHoveredId(String(point.payload?.id))}
              onMouseLeave={() => setHoveredId(null)}
              onClick={point => { setSelectedObservationId(String(point.payload?.id)); setInspectOpen(true); setHoveredId(null); }}
              line={false} shape={<PerformancePointGlyph />} isAnimationActive={false} />)}
          </ComposedChart>
        </ResponsiveContainer>
        {hoveredObservation && <div className="trend-hover-details"><PerformancePointTooltip observation={hoveredObservation} unit={unit} /></div>}
      </div> : <p className="trend-context-note">{inRangeObservations.length
        ? 'No opening holds match these filters. Try another duration or session order.'
        : 'No comparable opening holds in this date range. A prior curve and previously measured duration coverage are needed.'}</p>}
      <PerformancePointLegend grips={selectedGrips} />
      <div className="trend-context-note">
        First recorded does not mean recovered. Missing climbing logs leave workload unknown; orange bars are context only and do not adjust either curve.
        {laterHolds > 0 && <span> {laterHolds} comparable opening {laterHolds === 1 ? 'hold followed' : 'holds followed'} earlier recorded finger training in this date range.</span>}
      </div>
      <OpeningHoldInspector observations={visibleObservations} unit={unit} selectedId={selectedObservationId}
        onSelect={setSelectedObservationId} open={inspectOpen} onToggle={setInspectOpen} />
      <p className="trend-small">Both charts show {startDate} through {endDate}. Points stay separate across different hold durations. Expected force uses only earlier dates; that day’s results cannot change their own comparison.</p>
    </Card>
  </section>;
}
