import React, { useMemo } from 'react';
import { domainHistory } from '../../model/domainHistory.js';
import { MIXED_DOMAIN_LABELS } from '../../model/mixedDomain.js';
import { C } from '../../ui/theme.js';

export function DomainHistory({ history, grip, hands }) {
  const domains = useMemo(() => domainHistory(history, grip, hands), [history, grip, hands]);
  return <details style={{ marginBottom: 16, fontSize: 13 }}>
    <summary style={{ cursor: 'pointer', padding: '8px 0', color: C.muted }}>Your domain history</summary>
    <p style={{ color: C.muted, lineHeight: 1.5 }}>Choosing another domain keeps its earned progression.
      Whole Curve holds count as training; only an eligible opening hold updates opening-hold evidence.
      An opening hold is first in the set—it does not prove you were rested.</p>
    {Object.entries(domains).map(([zone, data]) => <div key={zone} style={{ padding: '8px 0', borderTop: `1px solid ${C.border}` }}>
      <strong>{MIXED_DOMAIN_LABELS[zone]}</strong>{' · '}{data.sessions} recorded workouts
      <div style={{ color: C.muted }}>Last trained: {data.lastTrained || 'not recorded'}
        {' · '}Opening evidence: {data.lastOpeningEvidence || 'not recorded'}</div>
    </div>)}
    <p style={{ color: C.muted }}>Training follows the planned domain. Opening evidence follows the duration actually held.
      Interrupted holds remain in History. Selecting both hands combines their dates.</p>
  </details>;
}
