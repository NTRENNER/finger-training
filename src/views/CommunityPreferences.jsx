import React, { useState } from 'react';
import { Card, Btn } from '../ui/components.jsx';
import { C } from '../ui/theme.js';

export function CommunityPreferences({ community }) {
  const [name, setName] = useState(null);
  const { owner, profile, sharing, update, pending, error, refresh } = community;
  if (!owner) return null;
  const displayName = name ?? profile?.display_name ?? '';
  return <Card>
    <h3 style={{ marginTop: 0 }}>Community sharing</h3>
    <label style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 44, cursor: 'pointer' }}>
      <input type="checkbox" checked={sharing} onChange={e => update({ sharing_enabled: e.target.checked })}
        style={{ width: 22, height: 22, accentColor: C.blue }} />
      <span>Share achievements and peak force</span>
    </label>
    <p style={{ color: C.muted, fontSize: 13, lineHeight: 1.6 }}>
      The app automatically shares new achievement cards, live progress rankings, your best measured peaks and your peak gains since joining with signed-in members under your display name.
      Rankings can include existing measurements. Turning this off hides your existing cards and ranking entries, too.
    </p>
    <form onSubmit={e => { e.preventDefault(); update({ display_name: displayName.trim() }); setName(null); }}>
      <label style={{ display: 'block', fontSize: 13 }}>Display name
        <input value={displayName} minLength={2} maxLength={32} required onChange={e => setName(e.target.value)}
          style={{ display: 'block', boxSizing: 'border-box', width: '100%', minHeight: 44, margin: '8px 0', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: 10, color: C.text }} />
      </label>
      <button type="submit" disabled={!profile || displayName.trim().length < 2 || displayName.trim() === profile.display_name}
        style={{ minHeight: 44, padding: '8px 16px', borderRadius: 8, background: C.border, border: 0, color: C.text }}>Save name</button>
    </form>
    {pending && <p role="status" style={{ color: C.yellow, fontSize: 13 }}>Preference saved on this device. Community visibility will update when it syncs.</p>}
    {error && <div role="status"><p>{error}</p><Btn small onClick={refresh}>Retry Community sync</Btn></div>}
  </Card>;
}
