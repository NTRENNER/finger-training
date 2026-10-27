import React from 'react';
import { C } from '../../ui/theme.js';
import { isPeakMeasurement, isValidPeakMeasurement } from '../../model/peakTest.js';

// Keep measurement provenance available without crowding the rep's result.
// A Peak Test pull is never a failure hold (failure_valid is false by
// design), so only an invalid pull reads as interrupted.
export function RepResultDetails({ rep, children }) {
  const interrupted = isPeakMeasurement(rep) ? !isValidPeakMeasurement(rep)
    : rep.failure_valid === false
      || rep.force_recording?.duration_basis === 'elapsed_activity_estimate';
  const releaseUncertain = rep.force_recording?.recording_stop_reason === 'release_not_observed';
  const detailRows = React.Children.toArray(children).filter(Boolean);
  return <>
    {interrupted && <div style={{ color: C.muted }}>{rep.end_reason === 'target_not_reached' ? 'Target not reached' : 'Interrupted'}</div>}
    {!interrupted && releaseUncertain && <div style={{ color: C.muted }}>Release not detected</div>}
    {detailRows.length > 0 && <details onClick={event => event.stopPropagation()} style={{ marginTop: 4 }}>
      <summary style={{ cursor: 'pointer', color: C.muted, fontSize: 12, padding: '12px 0', lineHeight: '20px' }}>Details</summary>
      <div style={{ fontSize: 12, lineHeight: 1.5 }}>
        {detailRows}
      </div>
    </details>}
  </>;
}
