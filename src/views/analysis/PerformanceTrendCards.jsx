import React, { useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Scatter, XAxis, YAxis,
  CartesianGrid, ReferenceLine,
} from 'recharts';
import { CHART } from '../../ui/chartStyles.js';
import { Card, CardTitle } from '../../ui/components.jsx';
import { C } from '../../ui/theme.js';
import { GRIP_COLORS } from '../../ui/grip-colors.js';
import { DateRangeSlider, normalizeHistoryWindow } from '../../ui/DateRangeSlider.jsx';
import { usePerformanceObservations } from '../../hooks/usePerformanceObservations.js';
import { suggestCookedFromClimbs } from '../../model/climbingFatigue.js';
import {
  BAND_LABELS, CONTEXT_LABELS, PerformancePointGlyph,
  PerformancePointLegend, PerformancePointTooltip, OpeningHoldInspector,
} from './PerformanceTrendEvidence.jsx';
import './PerformanceTrendCards.css';

const EMPTY = [];
const fmtDate = timestamp => new Date(timestamp).toISOString().slice(5, 10);
const shortDomain = ([low, high]) => {
  const span = Math.max(5, Math.abs(low || 0), Math.abs(high || 0));
  return [-Math.ceil(span), Math.ceil(span)];
};
const cardStyle = { marginBottom: 16, padding: '20px clamp(14px, 4vw, 24px)', minWidth: 0 };

export function PerformanceTrendCards({
  history = EMPTY, grips = EMPTY, handView = 'pooled', activities = EMPTY, unit = 'kg',
}) {
  const selectedGrips = grips || EMPTY;
  // Recompute only when source history or scope changes. Date and point
  // filters expose a view of the historical observations; they never rebase them.
  const { loading, result: analysis } = usePerformanceObservations(history, selectedGrips, handView);
  const rows = analysis?.rows || EMPTY;
  const observations = analysis?.observations || EMPTY;
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
    ...row,
    climbLoad: suggestCookedFromClimbs(activities, row.date)?.cooked ?? null,
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
  const laterHolds = inRangeObservations.filter(item => item.context === 'after_training').length;

  if (!rows.length) return <section className="performance-trends" aria-label="Performance trends">
    <Card style={cardStyle}>
      <CardTitle>Recent Performance vs Expected</CardTitle>
      <p className="trend-intro" role={loading ? 'status' : undefined}>{loading
        ? 'Calculating expected performance for each opening hold…'
        : 'Opening-hold comparisons appear once a calibrated pre-session curve is available.'}</p>
    </Card>
  </section>;

  return <section className="performance-trends" aria-label="Performance trends">
    <Card style={cardStyle}>
      <CardTitle>Recent Performance vs Expected</CardTitle>
      <p className="trend-intro">Session Performance = (observed force − expected force) / expected force × 100. The workout's prescribed force and target time anchor the pre-session curve, so clearing both targets appears above zero. Older sessions reconstruct the curve from earlier history only. −20% means 20% less force than expected for that hold, not a 20% loss of maximum strength.</p>
      <DateRangeSlider dates={dates} start={start} end={end} onChange={(a, b) => setWindow([dates[a], dates[b]])} />
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
            <ReferenceLine yAxisId="trend" y={0} stroke={C.muted} strokeDasharray="5 5" label={{ value: "Expected (0%)", fill: C.muted, position: "insideRight" }} />
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
        : 'No comparable opening holds in this date range. A calibrated curve based on earlier training is needed.'}</p>}
      <PerformancePointLegend grips={selectedGrips} />
      <div className="trend-context-note">
        First recorded does not mean recovered. Same-day climbing may have happened before or after finger training. Missing climbing logs leave workload unknown; orange bars are context only and do not adjust the calibrated expectation.
        {laterHolds > 0 && <span> {laterHolds} comparable opening {laterHolds === 1 ? 'hold followed' : 'holds followed'} earlier recorded finger training in this date range.</span>}
      </div>
      <OpeningHoldInspector observations={visibleObservations} unit={unit} selectedId={selectedObservationId}
        onSelect={setSelectedObservationId} open={inspectOpen} onToggle={setInspectOpen} />
      <p className="trend-small">This chart shows {startDate} through {endDate}. Points stay separate across different hold durations. Expected force uses the saved workout target and pre-session curve when available; that workout’s results cannot change its own comparison. Ringed points extend beyond the prior measured duration range.</p>
    </Card>
  </section>;
}
