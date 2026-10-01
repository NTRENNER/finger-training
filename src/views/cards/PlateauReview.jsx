import React, { useMemo } from 'react';
import { Card } from '../../ui/components.js';
import { C } from '../../ui/theme.js';
import { today } from '../../util.js';
import { toDisp } from '../../ui/format.js';
import { detectPlateaus, PLATEAU_REASON } from '../../model/plateau.js';
const labels = { power: 'Power', power_strength: 'Power/Strength', strength: 'Strength', strength_endurance: 'Strength/Endurance', endurance: 'Endurance' };
const statuses = { insufficient: 'More comparable holds needed', variable: 'Too variable to judge', improving: 'Improving', declining: 'Declining', stale: 'Recent evidence needed', watch: 'Recent slowing — keep observing', plateau: 'Possible persistent plateau' };
export function PlateauReview({ history = [], activities = [], experiments = {}, unit = 'lbs', date = today() }) {
  const report = useMemo(() => detectPlateaus({ history, activities, experiments, asOf: date }), [history, activities, experiments, date]);
  return <Card>
    <h2 style={{ marginTop: 0 }}>Plateau review · Research</h2>
    <p style={{ color: C.muted }}>Fresh opening holds at nearly the same measured force, compared across two four-week periods. A possible plateau must also appear in a review ending two weeks earlier. These are experimental screening rules, not a diagnosis or proof that more training will help.</p>
    {report.byGrip.map(g => <section key={g.grip} aria-label={`${g.grip} plateau review`} style={{ borderTop: `1px solid ${C.border}`, paddingTop: 16, marginTop: 16 }}>
      <h3>{g.grip}</h3>
      <p>{g.recommendation === 'consider_volume_beta'
        ? 'An optional six-week Volume Beta may be worth testing for the duration ranges below. Review fatigue and climbing quality before enrolling.'
        : 'Keep the current plan while gathering comparable evidence.'}</p>
      <p style={{ color: C.muted }}>Training days: {g.frequency.earlyDays} in the earlier four weeks · {g.frequency.recentDays} in the recent four weeks.</p>
      {g.blockers.length > 0 && <ul>{g.blockers.map(reason => <li key={reason}>{PLATEAU_REASON[reason]}</li>)}</ul>}
      {g.context.contextLimited && <p style={{ color: C.muted }}>Climbing or fatigue context is incomplete. Missing logs do not mean no climbing or full recovery.</p>}
      <details><summary>Evidence by hand and duration range</summary>
        {g.cells.map(c => <div key={`${c.hand}-${c.zone}`} style={{ padding: '12px 0', borderBottom: `1px solid ${C.border}` }}>
          <strong>{c.hand === 'L' ? 'Left' : 'Right'} · {labels[c.zone]}</strong> — {statuses[c.status]}
          {c.current && <p style={{ color: C.muted, margin: '6px 0' }}>
            Around {toDisp(c.forceKg, unit).toFixed(1)} {unit} · {c.current.earlyCount} earlier / {c.current.recentCount} recent dates.
            {c.current.changePct != null && <> Median hold {c.current.earlyS.toFixed(1)}s → {c.current.recentS.toFixed(1)}s ({c.current.changePct >= 0 ? '+' : ''}{c.current.changePct.toFixed(1)}%).</>}
          </p>}
        </div>)}
      </details>
    </section>)}
    <p style={{ color: C.muted, fontSize: 13 }}>Later sessions and sets, fatigued Chaos holds, interrupted capacity measurements, unknown session order, and mismatched timing or equipment are not used to establish a plateau. A plateau in one duration range does not establish a whole-curve plateau.</p>
  </Card>;
}
