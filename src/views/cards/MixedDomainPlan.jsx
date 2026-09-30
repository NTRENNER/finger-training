import React from 'react';
import './MixedDomainPlan.css';
import { C } from '../../ui/theme.js';
import { fmtW } from '../../ui/format.js';
import { MIXED_DOMAIN_ZONES, MIXED_DOMAIN_LABELS, mixedDomainSteps } from '../../model/mixedDomain.js';

export function MixedDomainPlan({ plan, readiness, hands, unit, multiplier, onOpeningChange, goalConfig = {} }) {
  const targetSeconds = (plan.steps.reduce((sum, step) => sum + step.targetTime, 0) + 4 * 30) * hands.length;
  const targetEstimate = `${Math.floor(targetSeconds / 60)}:${String(targetSeconds % 60).padStart(2, '0')}`;
  return <section aria-label="Chaos Machine beta plan" style={{ marginBottom: 20 }}>
    <p style={{ fontSize: 16, lineHeight: 1.5 }}>Five holds per hand. A different target weight each hold. Rest 30 seconds between holds.</p>
    <p style={{ color: C.muted, lineHeight: 1.5 }}>
      Where your measured history supports it, later target weights are adjusted for earlier pulls and rest, then fixed for each hold.
      Incomplete measurements during this session can also prevent an adjustment.
    </p>
    {readiness?.status === 'ready' ? <p style={{ color: C.muted, lineHeight: 1.5 }}>
      Time if all targets are reached: {targetEstimate}{hands.length === 2 ? ' for both hands' : ' for one hand'}, including rests. Setup and hand changes add time.
    </p> : <p style={{ color: C.yellow, lineHeight: 1.5 }}>
      {readiness?.status === 'partial' ? 'Some holds need more measured history.' : 'More measured history is needed for automatic adjustments.'}
      {' '}You can still train with the reference target weights. You may reach failure earlier than the displayed times, so session length will vary.
    </p>}
    <label style={{ display: 'block', marginBottom: 6 }}>
      First domain
      <select value={plan.steps[0].zone} onChange={e => onOpeningChange(e.target.value)}
        style={{ display: 'block', width: '100%', minHeight: 48, marginTop: 8, padding: 10,
          background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 16 }}>
        {MIXED_DOMAIN_ZONES.map(z => <option key={z} value={z}>{MIXED_DOMAIN_LABELS[z]}</option>)}
      </select>
    </label>
    <p style={{ margin: '0 0 16px', color: C.muted, fontSize: 13 }}>Starts with your recommended domain unless you choose another. Continues through the domains in order, wrapping from Endurance to Power. Both hands follow the same sequence.</p>
    <div className="mixed-plan-hands" style={{ '--mixed-plan-columns': hands.length }}>
      {hands.map(hand => <div key={hand} style={{ minWidth: 0 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>{hand === 'L' ? 'Left hand' : 'Right hand'}</h3>
        <ol className="mixed-plan-holds" aria-label={`${hand === 'L' ? 'Left' : 'Right'} hand holds`}>
          {mixedDomainSteps(plan, hand).map((step, i) => {
            const domain = goalConfig[step.zone];
            return <li key={step.zone} className="mixed-plan-hold"
              style={{ background: C.bg, border: `1px solid ${C.border}` }}>
              <div className="mixed-plan-hold-heading">
                <span style={{ color: domain?.color || C.text, fontSize: 14, fontWeight: 700 }}>
                  {i + 1}. {domain?.emoji} {MIXED_DOMAIN_LABELS[step.zone]}
                </span>
                <span style={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  {step.targetTime}s
                </span>
              </div>
              <strong style={{ display: 'block', marginTop: 8, fontSize: 24, lineHeight: 1.2, color: C.blue }}>
                {fmtW(step.loadByHand[hand] * multiplier, unit)} <span style={{ fontSize: 14 }}>{unit}</span>
              </strong>
              <div style={{ color: C.muted, fontSize: 12, marginTop: 6 }}>
                {i === 0 ? 'First hold · Fresh reference' : readiness?.byHand?.[hand]?.[i]?.status === 'ready'
                  ? 'Reference · adjustment estimated before this hold' : 'Reference target · adjustment unavailable'}
              </div>
              {i > 0 && readiness?.byHand?.[hand]?.[i]?.status !== 'ready' && <p style={{ color: C.muted, fontSize: 12, margin: '6px 0 0' }}>
                {readiness?.byHand?.[hand]?.[i]?.reason === 'outside_measured_duration_range'
                  ? 'This duration is outside the measured range for this hand.'
                  : 'More measured history is needed for this hand.'}
              </p>}
            </li>;
          })}
        </ol>
      </div>)}
    </div>
    <p style={{ color: C.muted, lineHeight: 1.5 }}>{readiness?.status === 'ready' ? 'Adjusted targets aim for approximately the displayed times.' : 'The displayed times identify each domain; reference weights may not produce holds that long after earlier work.'} Keep your pulling force steady at the target weight and hold until failure; reaching the target does not stop the timer.</p>
    <p style={{ color: C.muted, lineHeight: 1.5 }}>Your first measured hold can update the curve. Later holds are saved as fatigued work. These estimates are experimental. Your 4–6 rep progression is unchanged.</p>
  </section>;
}
