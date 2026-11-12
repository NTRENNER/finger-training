import React, { useEffect, useRef, useState } from 'react';
import { C } from '../ui/theme.js';
import { Card, Btn } from '../ui/components.jsx';
import { toDisp } from '../ui/format.js';
import { ZONE_REF_T } from '../model/zones.js';
import { COMMUNITY_METRICS } from '../lib/communityProgress.js';
import { communityBaselineBand, communityGroupKey } from '../lib/communityRankings.js';
import { readCommunityGroups, readCommunityImprovements } from '../lib/communityApi.js';

const number = value => Number(value).toFixed(1);
const force = (kg, unit) => `${number(toDisp(kg, unit))} ${unit}`;
const dateLabel = date => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function RankingRows({ rows, unit, balanced }) {
  return <table aria-label={balanced ? 'Balanced curve improvement rankings' : undefined}
    style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 13 }}>
    <thead><tr>
      <th scope="col" style={{ width: 28, textAlign: 'left', color: C.muted, fontWeight: 400, paddingBottom: 12 }}>#</th>
      <th scope="col" style={{ textAlign: 'left', color: C.muted, fontWeight: 400, paddingBottom: 12 }}>Member</th>
      <th scope="col" style={{ width: balanced ? 112 : 88, textAlign: 'right', color: C.muted, fontWeight: 400, paddingBottom: 12 }}>Gain</th>
    </tr></thead>
    <tbody>{rows.map(row => <tr key={row.user_id} style={{ borderTop: `1px solid ${C.border}` }}>
      <td style={{ padding: '12px 4px 12px 0', color: C.muted, fontVariantNumeric: 'tabular-nums' }}>{row.place}</td>
      <td style={{ padding: '12px 6px 12px 0', overflowWrap: 'anywhere' }}>{row.display_name}
        {balanced && <div style={{ fontSize: 12, color: C.muted, marginTop: 5 }}>
          {number(toDisp(row.baseline_force_kg, unit))} → {force(row.current_force_kg, unit)}
        </div>}
        <div style={{ fontSize: 11, color: C.muted, marginTop: 5 }}>{dateLabel(row.baseline_date)} → {dateLabel(row.measured_date)}</div>
      </td>
      <td style={{ padding: '12px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        <strong style={{ color: C.blue, whiteSpace: 'nowrap' }}>+{number(row.improvement_pct)}%</strong>
        <div style={{ fontSize: 12, color: C.yellow, marginTop: 5 }}>★ {row.milestone_pct}%{balanced ? ' milestone' : ''}</div>
      </td>
    </tr>)}</tbody>
  </table>;
}

function DomainRanking({ metric, rows, unit, loading }) {
  const balanced = metric.key === 'balanced';
  const firstCount = balanced ? 10 : 5;
  return <Card style={{ padding: 16, marginBottom: 0, minWidth: 0 }}>
    <h3 style={{ fontSize: 16, margin: '0 0 8px' }}>{balanced ? 'Balanced curve improvement' : metric.label}</h3>
    <p style={{ color: C.muted, fontSize: 12, margin: '0 0 16px', lineHeight: 1.5 }}>
      {balanced ? 'Estimated change · Same curve durations' : `Estimated force at ${ZONE_REF_T[metric.key]} seconds`}
    </p>
    {rows.length ? <>
      <RankingRows rows={rows.slice(0, firstCount)} unit={unit} balanced={balanced} />
      {rows.length > firstCount && <details><summary style={{ minHeight: 44, padding: '12px 0', cursor: 'pointer', color: C.blue, fontSize: 13 }}>
        See {rows.length - firstCount} more
      </summary><RankingRows rows={rows.slice(firstCount)} unit={unit} balanced={balanced} /></details>}
    </> : <p style={{ color: C.muted, fontSize: 13 }}>{loading ? 'Loading rankings…' : 'No confirmed milestones in this group yet.'}</p>}
  </Card>;
}

export function CommunityRankings({ owner, grip, unit, revision, ownSnapshots = [], liveStatus }) {
  const [selection, setSelection] = useState(null);
  const [data, setData] = useState({ groups: [], selected: null, rows: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const previousScope = useRef(null);
  const own = ownSnapshots.find(row => row.grip === grip);
  const ownKey = own ? communityGroupKey({ baseline_band: communityBaselineBand(own.group_force_kg), support_keys: own.support_keys }) : null;
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    const scope = JSON.stringify([owner, grip, selection, ownKey]);
    if (previousScope.current !== scope) setData({ groups: [], selected: null, rows: [] });
    previousScope.current = scope;
    (async () => {
      const groups = await readCommunityGroups(owner, grip);
      if (cancelled) return;
      const selected = groups.find(group => communityGroupKey(group) === selection)
        || groups.find(group => communityGroupKey(group) === ownKey) || groups[0] || null;
      const rows = selected ? await readCommunityImprovements(owner, grip, selected) : [];
      if (!cancelled) setData({ groups, selected, rows });
    })().catch(() => { if (!cancelled) setError('Rankings could not load. Please try again when you’re online.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [owner, grip, selection, ownKey, revision, retry]);
  const groupLabel = group => {
    const seconds = group.support_keys.map(key => ZONE_REF_T[key]).sort((a, b) => a - b);
    return `${number(toDisp(group.baseline_band, unit))}–${force(group.baseline_band + 10, unit)} · ${seconds[0]}–${seconds.at(-1)}s`;
  };
  return <section aria-label="Improvement rankings">
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
      <label style={{ color: C.muted, fontSize: 13, maxWidth: '100%' }}>Starting capacity
        <select aria-label="Starting capacity group" value={data.selected ? communityGroupKey(data.selected) : ''}
          disabled={!data.groups.length} onChange={event => setSelection(event.target.value)}
          style={{ display: 'block', maxWidth: '100%', minHeight: 44, fontSize: 16, marginTop: 8, padding: '8px 10px', borderRadius: 8, color: C.text, background: C.card, border: `1px solid ${C.border}` }}>
          {!data.groups.length && <option value="">{loading ? 'Loading groups…' : 'Building comparable evidence'}</option>}
          {data.groups.map(group => <option key={communityGroupKey(group)} value={communityGroupKey(group)}>{groupLabel(group)}</option>)}
        </select>
      </label>
      <div style={{ fontSize: 12, color: C.muted }}><span style={{ color: liveStatus === 'live' ? C.green : C.muted }}>
        {liveStatus === 'live' ? '● Live' : liveStatus === 'offline' ? 'Offline' : 'Refreshing automatically'}
      </span><br />Latest recorded progress · Since individual baselines</div>
    </div>
    {error ? <Card><p role="status">{error}</p><Btn onClick={() => setRetry(value => value + 1)}>Retry rankings</Btn></Card> : <>
      <DomainRanking metric={COMMUNITY_METRICS[0]} rows={data.rows.filter(row => row.metric === 'balanced')} unit={unit} loading={loading} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 210px), 1fr))', gap: 12, marginTop: 12 }}>
        {COMMUNITY_METRICS.slice(1).map(metric => <DomainRanking key={metric.key} metric={metric}
          rows={data.rows.filter(row => row.metric === metric.key)} unit={unit} loading={loading} />)}
      </div>
      <p style={{ color: C.muted, fontSize: 12, lineHeight: 1.6 }}>★ Milestones recognize personal progress, independently of rank. Top 100 per domain; exact ties share a rank. Starting groups match balanced capacity and curve coverage. Each member’s dates show their comparison period.</p>
      <div role="status" aria-live="polite" style={{ fontSize: 12, color: C.muted }}>
        {loading ? 'Loading improvement rankings…' : data.selected ? `${data.selected.members} members in this starting group` : 'New milestones will appear as comparable evidence builds.'}
      </div>
    </>}
  </section>;
}
