import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { useEscapeDismiss } from '../../hooks/useEscapeDismiss.js';
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss.js';
import { suggestCookedFromClimbs } from '../../model/climbingFatigue.js';
import {
  BAND_LABELS, CONTEXT_LABELS, PerformancePointGlyph,
  PerformanceObservationDetails, PerformancePointLegend,
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
  history = EMPTY, grips = EMPTY, handView = 'pooled', activities = EMPTY, unit = 'kg', onAnalysis,
}) {
  const selectedGrips = grips || EMPTY;
  // Recompute only when source history or scope changes. Date and point
  // filters expose a view of the historical observations; they never rebase them.
  const { loading, result: analysis } = usePerformanceObservations(history, selectedGrips, handView);
  const rows = analysis?.rows || EMPTY;
  const observations = analysis?.observations || EMPTY;
  useEffect(() => { onAnalysis?.(analysis || null); }, [analysis, onAnalysis]);
  const [window, setWindow] = useState(null);
  const [durationBand, setDurationBand] = useState('all');
  const [sessionContext, setSessionContext] = useState('all');
  const [selectedObservationId, setSelectedObservationId] = useState(null);
  const popupRef = useRef(null);
  const closePopup = () => setSelectedObservationId(null);
  useEscapeDismiss(Boolean(selectedObservationId), closePopup);
  useOutsideDismiss(Boolean(selectedObservationId), popupRef, closePopup, '.trend-point-glyph');
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
  const selectedObservation = visibleObservations.find(item => String(item.id) === selectedObservationId);

  if (!rows.length) return <section className="performance-trends" aria-label="Performance trends">
    <Card style={cardStyle}>
      <CardTitle>Recent Performance vs Prediction</CardTitle>
      <p className="trend-intro" role={loading ? 'status' : undefined}>{loading
        ? 'Calculating performance predictions…'
        : 'Comparisons appear once a pre-workout prediction is available.'}</p>
    </Card>
  </section>;

  return <section className="performance-trends" aria-label="Performance trends">
    <Card style={cardStyle}>
      <CardTitle>Recent Performance vs Prediction</CardTitle>
      <DateRangeSlider dates={dates} start={start} end={end} onChange={(a, b) => {
        setWindow([dates[a], dates[b]]);
        setSelectedObservationId(null);
      }} />
      <div className="trend-filters">
        <label className="trend-filter">Hold duration
          <select value={durationBand} onChange={event => {
            setDurationBand(event.target.value);
            setSelectedObservationId(null);
          }}>
            <option value="all">All hold durations</option>
            {Object.entries(BAND_LABELS).map(([key, label]) => <option value={key} key={key}>{label}</option>)}
          </select>
        </label>
        <label className="trend-filter">Finger session order
          <select value={sessionContext} onChange={event => {
            setSessionContext(event.target.value);
            setSelectedObservationId(null);
          }}>
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
            <ReferenceLine yAxisId="trend" y={0} stroke={C.muted} strokeDasharray="5 5" label={{ value: "Prediction (0%)", fill: C.muted, position: "insideRight" }} />
            <Bar yAxisId="climb" dataKey="climbLoad" name="Logged climbing load" fill={C.orange} opacity={.4} barSize={6} isAnimationActive={false} />
            {observationSeries.map(({ grip, observations: gripObservations }) => <Scatter key={grip} yAxisId="trend" dataKey="deviation" name={grip}
              data={gripObservations} fill={GRIP_COLORS[grip] || C.blue}
              onClick={point => {
                const id = String(point.payload?.id);
                setSelectedObservationId(current => current === id ? null : id);
              }}
              line={false} shape={<PerformancePointGlyph />} isAnimationActive={false} />)}
          </ComposedChart>
        </ResponsiveContainer>
        {selectedObservation && <div ref={popupRef} className="trend-point-popup" role="dialog" aria-label="Opening hold details">
          <button type="button" className="trend-point-popup-close" aria-label="Close point details"
            onClick={() => setSelectedObservationId(null)}>×</button>
          <PerformanceObservationDetails observation={selectedObservation} unit={unit} />
        </div>}
      </div> : <p className="trend-small">{inRangeObservations.length
        ? 'No opening holds match these filters. Try another duration or session order.'
        : 'No comparable opening holds in this date range.'}</p>}
      <PerformancePointLegend grips={selectedGrips} />
    </Card>
  </section>;
}
