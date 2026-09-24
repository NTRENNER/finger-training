import React, { useMemo } from 'react';
import { HistoricalPredictionReview } from './HistoricalPredictionReview.jsx';
import { Card, Btn } from '../../ui/components.js';
import { C } from '../../ui/theme.js';
import { REVIEW_DAYS, summarizePredictions } from '../../model/predictionTracking.js';

const labels = { max_strength: 'Peak', power: 'Power', power_strength: 'Power / Strength',
  strength: 'Strength', strength_endurance: 'Strength / Endurance', endurance: 'Endurance' };

function Score({ title, score, unit, factor = 1, candidateLabel = 'Candidate' }) {
  const fmt = n => n == null ? '—' : `${(n * factor).toFixed(1)} ${unit}`;
  return <section style={{ marginTop: 20 }}>
    <h4 style={{ margin: '0 0 8px' }}>{title}</h4>
    <div style={{ color: C.muted, marginBottom: 8 }}>{score.current.days} training days · {score.current.observations} holds</div>
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', textAlign: 'left', fontSize: 14, borderCollapse: 'collapse' }}>
        <thead><tr><th scope="col">Error</th><th scope="col">Current</th><th scope="col">{candidateLabel}</th></tr></thead>
        <tbody>{[['Typical', 'mae'], ['Larger misses', 'rmse'], ['Bias', 'bias']].map(([name, key]) =>
          <tr key={key}><th scope="row" style={{ fontWeight: 400, padding: '6px 4px 6px 0' }}>{name}</th>
            <td>{fmt(score.current[key])}</td><td>{fmt(score.candidate[key])}</td></tr>)}</tbody>
      </table>
    </div>
  </section>;
}

export function PredictionAccuracyCard({ history, unit = 'lbs' }) {
  const report = useMemo(() => summarizePredictions(history), [history]);
  const factor = unit === 'lbs' ? 2.2046226218 : 1;
  const excluded = Object.values(report.exclusions).reduce((sum, n) => sum + n, 0);
  const exportReport = () => {
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), ...report,
      saved_forecasts: history.filter(r => r.force_recording?.prediction_check) }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url;
    link.download = `prediction-review-${new Date().toISOString().slice(0, 10)}.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <Card>
    <h3 style={{ margin: '0 0 10px' }}>Prediction accuracy</h3>
    <HistoricalPredictionReview history={history} unit={unit} />
    <strong>New saved forecasts</strong>
    <div style={{ fontSize: 20, fontWeight: 700, color: report.days >= REVIEW_DAYS ? C.green : C.text }}>
      {report.days < REVIEW_DAYS ? `${report.days} of ${REVIEW_DAYS} training days` : 'Ready for a model review'}
    </div>
    <p style={{ color: C.muted, lineHeight: 1.5 }}>
      {report.days < REVIEW_DAYS
        ? 'During standard sessions, we save estimates before your holds and check them against your results. The first new-data checkpoint is after 10 days with comparable opening holds.'
        : `${report.days} days with comparable opening holds. Review checkpoint ${report.checkpoints} reached; the next is in ${report.daysToNextCheckpoint} more training days.`}
    </p>
    <div style={{ color: C.muted, fontSize: 13 }}>All grips and both hands · Each day counts once · Recommendations stay unchanged</div>
    <details style={{ marginTop: 14 }}>
      <summary style={{ cursor: 'pointer', padding: '8px 0' }}>See the comparison</summary>
      <p style={{ color: C.muted, lineHeight: 1.5 }}>We compare the current capacity curve with a candidate fitted to opening holds.
        Both use the same prior history and anchoring rules. A review checks each grip and duration before any change is made.</p>
      <p style={{ color: C.muted, fontSize: 13 }}>These checks cover standard single-domain sessions. Whole Curve beta and peak tests use separate measurements.</p>
      {!report.days && <p>No comparable opening holds saved yet. Recording starts with new standard sessions;
        older workouts still train the models. Each curve needs at least five prior training days.</p>}
      <Score title="Force at the time you held" score={report.force} unit={unit} factor={factor} />
      <p style={{ color: C.muted, fontSize: 13, lineHeight: 1.5 }}>This checks the saved curves at your eventual hold duration, including valid overshoots.
        It is a comparison after the hold, not an advance prediction of its duration.</p>
      {report.days >= REVIEW_DAYS && <Score title="Most recent 10 training days" score={report.lastTenDays} unit={unit} factor={factor} />}
      {Object.entries(report.byGrip).map(([grip, score]) => <Score key={grip} title={grip} score={score} unit={unit} factor={factor} />)}
      <details style={{ marginTop: 16 }}><summary style={{ cursor: 'pointer' }}>By planned domain</summary>
        {Object.entries(report.byDomain).map(([domain, score]) => <Score key={domain} title={labels[domain] || domain} score={score} unit={unit} factor={factor} />)}
        <p style={{ color: C.muted, fontSize: 13 }}>Grouped by the planned session. The review download also separates the durations actually held.</p>
      </details>
      <Score title="Advance hold-time estimates" score={report.plannedForce} unit="s" />
      <p style={{ color: C.muted, fontSize: 13 }}>Only holds within 10% of the planned force enter this check.
        These estimates use the capacity curves; load limits and the rep ladder are separate.</p>
      <details style={{ marginTop: 16 }}>
        <summary style={{ cursor: 'pointer' }}>Established ability + recent performance</summary>
        <p style={{ color: C.muted, lineHeight: 1.5 }}>A separate background comparison tests a steadier curve
          with adjustments when several training days agree. It does not change your workout loads.</p>
        <p>{report.adaptive.days} new training days · {report.adaptive.days >= REVIEW_DAYS
          ? `Review checkpoint ${report.adaptive.checkpoints} reached`
          : `${report.adaptive.daysToNextCheckpoint} more until the first review`}</p>
        {report.adaptive.days > 0 && <>
          <Score title="Established + recent curve" score={report.adaptive.force} unit={unit} factor={factor} candidateLabel="New model" />
          <Score title="Established + recent hold-time estimates" score={report.adaptive.plannedForce} unit="s" candidateLabel="New model" />
        </>}
        <p style={{ color: C.muted, fontSize: 13 }}>Only new forecasts from this version count. Time comparisons require force
          within 5% of plan. These scores test the curves; the proposed loads and floor adjustments are saved separately
          in the download. Each grip and duration needs review before changing recommendations.</p>
      </details>
      <Score title="Between-rep recovery · approximate" score={report.recovery} unit="s" candidateLabel="Population" />
      <p style={{ color: C.muted, fontSize: 13 }}>Current recovery versus the population estimate, checked using measured rest and similar force across holds.</p>
      <Score title="Advance recovery estimates" score={report.plannedRecovery} unit="s" candidateLabel="Population" />
      <p style={{ color: C.muted, fontSize: 13, lineHeight: 1.5 }}>This separate check also requires rest within 2 seconds of the plan.
        Lower error is better. Positive bias means overestimating; negative means underestimating.
        “Typical” is mean absolute error; “Larger misses” is root mean square error. A small sample cannot establish a winner.</p>
      {excluded > 0 && <p style={{ color: C.muted, fontSize: 13 }}>{excluded} saved checks are not comparable yet or were excluded.
        Interrupted holds, changed records and incomplete measurements do not count against either model. Reasons are included in the download.</p>}
      <Btn onClick={exportReport}>Download review</Btn>
      <p style={{ color: C.muted, fontSize: 13 }}>At each checkpoint, ask for a prediction review and share this download.
        It includes frozen forecasts, results and separate scores for each grip and domain.</p>
    </details>
  </Card>;
}
