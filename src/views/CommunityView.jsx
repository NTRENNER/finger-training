import React, { useEffect, useMemo, useState } from 'react';
import { C } from '../ui/theme.js';
import { Card, PageFrame, Btn } from '../ui/components.jsx';
import { toDisp } from '../ui/format.js';
import { ymdLocal } from '../util.js';
import { useContinuousProgress } from '../hooks/useContinuousProgress.js';
import { COMMUNITY_METRICS, communityProgress, communityPeaks, publicationCandidates, similarStart } from '../lib/communityProgress.js';
import { readCommunityFeed, readCommunityRanking, hideCommunityCard, celebrateCommunityCard } from '../lib/communityApi.js';
import { communityImprovementSnapshots } from '../lib/communityRankings.js';
import { CommunityRankings } from './CommunityRankings.jsx';

const GRIPS = ['Crusher', 'Micro', 'Prime'];
const label = key => COMMUNITY_METRICS.find(m => m.key === key)?.label || key;
const percent = value => `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
const chip = selected => ({ minHeight: 44, padding: '8px 14px', borderRadius: 22, border: `1px solid ${selected ? C.blue : C.border}`,
  background: selected ? '#192b40' : C.card, color: selected ? C.blue : C.text, cursor: 'pointer' });

export function CommunityView({ visible, ready, paused, community, history, pinnedGripBaselines, pinnedPerHandBaselines, unit = 'lbs' }) {
  // Shown under the Fingers dashboard: nothing appears until there is a
  // signed-in member with synced history, and nothing during training.
  if (!ready || !community.owner || paused) return null;
  return <CommunityExperience {...{ visible, community, history, pinnedGripBaselines, pinnedPerHandBaselines, unit }} />;
}

function CommunityExperience({ visible, community, history, pinnedGripBaselines, pinnedPerHandBaselines, unit }) {
  const grips = useMemo(() => GRIPS.filter(g => history.some(r => r.grip === g)), [history]);
  const { historyOverlay, displayHistory } = useContinuousProgress({ history, grips, pinnedGripBaselines, pinnedPerHandBaselines });
  const today = ymdLocal();
  const progress = useMemo(() => communityProgress(displayHistory, historyOverlay, today), [displayHistory, historyOverlay, today]);
  const peaks = useMemo(() => communityPeaks(displayHistory, today, community.profile?.created_at),
    [displayHistory, today, community.profile?.created_at]);
  const rankings = useMemo(() => communityImprovementSnapshots(displayHistory, historyOverlay, today), [displayHistory, historyOverlay, today]);
  const candidates = useMemo(() => community.profile?.created_at
    ? publicationCandidates(progress.stars, community.profile.created_at) : [], [progress.stars, community.profile?.created_at]);
  const { publish, sharing, pending, profile, revision } = community;
  useEffect(() => {
    if (profile && sharing && !pending) publish(candidates, peaks, rankings);
  }, [publish, sharing, pending, profile, candidates, peaks, rankings]);
  if (!visible) return null;
  return <CommunityScreen community={community} progress={progress} unit={unit} revision={revision} ownSnapshots={rankings} />;
}

export function CommunityScreen({ community, progress, unit = 'lbs', revision = 0, ownSnapshots = [] }) {
  const [grip, setGrip] = useState('Crusher');
  const [section, setSection] = useState('growth');
  const [similar, setSimilar] = useState(false);
  const [hand, setHand] = useState('');
  const [feed, setFeed] = useState([]);
  const [ranking, setRanking] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [mutation, setMutation] = useState(null);
  const [reload, setReload] = useState(0);
  const owner = community.owner;
  useEffect(() => { setCursor(null); }, [revision]);
  useEffect(() => {
    if (section === 'growth') { setLoading(false); setError(''); return; }
    let cancelled = false;
    setLoading(true); setError('');
    if (!cursor) setFeed([]);
    if (section === 'peaks') setRanking([]);
    const request = section === 'stories' ? readCommunityFeed(owner, grip, cursor) : readCommunityRanking(owner, grip, hand || null);
    request.then(rows => {
      if (cancelled) return;
      if (section === 'stories') { setFeed(old => cursor ? [...old, ...rows.filter(row => !old.some(r => r.id === row.id))] : rows); setMore(rows.length === 30); }
      else setRanking(rows);
    }).catch(() => { if (!cancelled) { setFeed([]); setRanking([]); setError('Community is unavailable. Try again when you’re online.'); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [owner, grip, section, hand, cursor, revision, reload]);
  async function act(card, hide) {
    if (mutation) return;
    setMutation(card.id);
    try {
      if (hide) await hideCommunityCard(owner, card.id);
      else await celebrateCommunityCard(owner, card.id, card.celebrated);
      setCursor(null); setReload(n => n + 1);
    } catch { setError('That change did not save. Please try again.'); }
    finally { setMutation(null); }
  }
  const strength = value => `${toDisp(value, unit).toFixed(1)} ${unit}`;
  const stars = progress.stars.filter(s => s.grip === grip);
  const visibleFeed = similar ? feed.filter(card => similarStart(card, progress.current)) : feed;
  return <PageFrame style={{ padding: '24px 16px 48px' }}>
    <h2 style={{ fontSize: 22, margin: '0 0 16px' }}>Community</h2>
    <div aria-label="Community grip" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
      {GRIPS.map(g => <button key={g} aria-pressed={grip === g} style={chip(grip === g)} onClick={() => { setGrip(g); setCursor(null); }}>{g}</button>)}
    </div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '24px 0 16px' }}>
      {[['growth', 'Improvement rankings'], ['peaks', 'Peak force'], ['stories', 'Achievements']].map(([key, title]) => <button key={key} aria-pressed={section === key} style={chip(section === key)} onClick={() => { setSection(key); setCursor(null); }}>{title}</button>)}
    </div>
    {section === 'growth' && <CommunityRankings key={grip} owner={owner} grip={grip} unit={unit} revision={revision} ownSnapshots={ownSnapshots} liveStatus={community.liveStatus} />}
    {section === 'stories' && <>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, marginBottom: 12 }}>
        <input type="checkbox" checked={similar} onChange={e => setSimilar(e.target.checked)} /> Similar starting points
      </label>
      {visibleFeed.map(card => <Card key={card.id}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><strong style={{ overflowWrap: 'anywhere' }}>{card.display_name}</strong><span style={{ color: C.yellow, whiteSpace: 'nowrap' }}>★ {card.milestone_pct}%</span></div>
        <h3>{label(card.metric)} breakthrough</h3>
        <p style={{ fontSize: 28, margin: '8px 0', color: C.blue }}>{percent(card.improvement_pct)} <span style={{ fontSize: 12, color: C.muted }}>estimated progress</span></p>
        <p style={{ color: C.muted, fontSize: 13 }}>{card.grip} · {card.baseline_date} → {card.achieved_date}</p>
        {card.metric !== 'balanced' && <p style={{ fontSize: 13 }}>{strength(card.baseline_force_kg)} → {strength(card.current_force_kg)} at the same curve duration</p>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button style={chip(card.celebrated)} disabled={!!mutation} aria-pressed={card.celebrated} onClick={() => act(card, false)}>Celebrate · {card.celebrations}</button>
          {card.user_id === owner && <button style={chip(false)} disabled={!!mutation} onClick={() => act(card, true)}>Hide card</button>}
        </div>
      </Card>)}
      {!loading && !error && !visibleFeed.length && <Card><h3>{similar ? 'A similar start is still a story to come.' : 'The next achievement could be yours.'}</h3>
        <p style={{ color: C.muted }}>{similar ? 'Try all starting points, or load more achievements.' : 'New milestones appear here automatically when members earn them.'}</p></Card>}
      {more && <Btn disabled={loading} onClick={() => setCursor(feed.at(-1))}>Load more achievements</Btn>}
    </>}
    {section === 'peaks' && <Card>
      <h2 style={{ fontSize: 20 }}>{grip} peak force improvement</h2>
      <p style={{ color: C.muted, fontSize: 13 }}>Largest percentage gains · First max-effort session since joining → best later peak · Top 100</p>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
        {[['', 'Most improved hand'], ['L', 'Left'], ['R', 'Right']].map(([key, title]) => <button key={key} style={chip(hand === key)} aria-pressed={hand === key} onClick={() => setHand(key)}>{title}</button>)}
      </div>
      {ranking.length > 0 && <table aria-label="Peak force improvement rankings" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead><tr>{['Rank', 'Member', 'Gain'].map(title => <th key={title} style={{ textAlign: 'left', paddingBottom: 12, color: C.muted }}>{title}</th>)}</tr></thead>
        <tbody>{ranking.map(row => <tr key={row.user_id} style={{ borderTop: `1px solid ${C.border}` }}>
          <td style={{ padding: '14px 6px 14px 0', color: C.yellow }}>{row.place}</td>
          <td style={{ maxWidth: 130, overflowWrap: 'anywhere', paddingRight: 8 }}>{row.display_name}
            <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{strength(row.baseline_peak_kg)} → {strength(row.peak_kg)}</div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{row.hand === 'L' ? 'Left' : 'Right'} · {row.baseline_date} → {row.measured_date}</div></td>
          <td style={{ whiteSpace: 'nowrap', fontWeight: 700, color: C.blue }}>{percent(row.improvement_pct)}</td>
        </tr>)}</tbody>
      </table>}
      {!loading && !error && !ranking.length && <p>No shared peak improvements since joining yet.</p>}
    </Card>}
    {loading && <p role="status">Loading community…</p>}
    {error && <div role="status"><p>{error}</p><Btn onClick={() => setReload(n => n + 1)}>Retry</Btn></div>}
    <details style={{ marginTop: 24 }}>
      <summary style={{ padding: '12px 0', minHeight: 44, cursor: 'pointer', color: C.yellow }}>Your stars · ★ {stars.length}</summary>
      <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ fontSize: 20 }}>Your stars</h2><span style={{ color: C.yellow, fontSize: 22 }}>★ {stars.length}</span>
      </div>
      <p style={{ color: C.muted, fontSize: 13 }}>Even 1% can be a milestone. Estimated gains seen on two training dates earn stars.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
        {COMMUNITY_METRICS.map(metric => {
          const current = progress.current.find(p => p.grip === grip && p.metric === metric.key);
          const earned = stars.filter(s => s.metric === metric.key).sort((a, b) => b.milestone_pct - a.milestone_pct)[0];
          return <div key={metric.key} style={{ padding: 12, border: `1px solid ${C.border}`, borderRadius: 12, gridColumn: metric.key === 'balanced' ? '1 / -1' : undefined }}>
            <div style={{ fontSize: 12, color: C.muted }}>{metric.label}</div>
            <div style={{ fontSize: 22, margin: '8px 0', color: earned ? C.yellow : C.text }}>{earned ? `★ ${earned.milestone_pct}%` : '—'}</div>
            <div style={{ fontSize: 12, color: C.muted }}>{current ? `Current estimate ${percent(current.percent)}` : 'Building evidence'}</div>
          </div>;
        })}
      </div>
      </Card>
    </details>
  </PageFrame>;
}
