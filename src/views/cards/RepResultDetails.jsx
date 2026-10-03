import React from 'react';
import { C } from '../../ui/theme.js';
import { evidenceLabel } from '../../model/forceRecording.js';

// Keep measurement provenance available without crowding the rep's result.
export function RepResultDetails({ rep, children }) {
  const interrupted = rep.failure_valid === false
    || rep.force_recording?.duration_basis === 'elapsed_activity_estimate';
  const releaseUncertain = rep.force_recording?.recording_stop_reason === 'release_not_observed';
  return <>
    {interrupted && <div style={{ color: C.muted }}>{rep.end_reason === 'target_not_reached' ? 'Target not reached' : 'Interrupted'}</div>}
    {!interrupted && releaseUncertain && <div style={{ color: C.muted }}>Release not detected</div>}
    <details onClick={event => event.stopPropagation()} style={{ marginTop: 4 }}>
      <summary style={{ cursor: 'pointer', color: C.muted, fontSize: 12, padding: '12px 0', lineHeight: '20px' }}>Details</summary>
      <div style={{ fontSize: 12, lineHeight: 1.5 }}>
        <div>{evidenceLabel(rep)}</div>
        {children}
      </div>
    </details>
  </>;
}
