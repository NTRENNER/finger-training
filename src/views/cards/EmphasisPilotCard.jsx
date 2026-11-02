import React from 'react';
import { Card, CardTitle, Btn } from '../../ui/components.jsx';
import { C } from '../../ui/theme.js';
import { today } from '../../util.js';
import { TARGET_OPTIONS, ZONE_REF_T } from '../../model/zones.js';
import {
  EMPHASIS_PILOTS, EMPHASIS_LABEL, activePilot, pilotBlockOn, pilotEnrollment, pilotLabel, pilotStep,
} from '../../model/emphasisPilot.js';

const PILOT_ID = 'emphasis-2026-11';
const zoneLabel = zone => TARGET_OPTIONS.find(o => o.seconds === ZONE_REF_T[zone])?.label ?? zone;
const shortDate = d => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// Join or leave the emphasis-block pilot (docs/emphasis-block-protocol.md).
// While joined, the plan card shows each grip's next pilot step.
export function EmphasisPilotCard({ enrollment, history = [], onSave, date = today() }) {
  const pilot = EMPHASIS_PILOTS[PILOT_ID];
  const joined = activePilot(enrollment)?.id === PILOT_ID;
  const block = pilotBlockOn(pilot, date);
  const schedule = pilot.blocks
    .map(b => `${EMPHASIS_LABEL[b.emphasis]} ${shortDate(b.start)}–${shortDate(b.end)}`).join(', then ');
  const grips = `${pilot.grips.slice(0, -1).join(', ')} and ${pilot.grips.at(-1)}`;
  const status = block ? pilotLabel(pilotStep(enrollment, history, pilot.primaryGrip, date))
    : date < pilot.blocks[0].start ? `Starts ${shortDate(pilot.blocks[0].start)}`
      : 'Finished. Recommendations are back to normal.';
  return <Card>
    <CardTitle>Emphasis-block pilot</CardTitle>
    <p style={{ color: C.muted, lineHeight: 1.5, marginTop: 0 }}>
      {schedule}. Every session on {grips} follows the block plan.
    </p>
    {joined && <>
      <p role="status" style={{ fontWeight: 700 }}>{status}</p>
      {block && <ul style={{ paddingLeft: 18, lineHeight: 1.6 }}>
        {pilot.grips.map(grip => {
          const step = pilotStep(enrollment, history, grip, date);
          return <li key={grip}>{grip}: {zoneLabel(step.zone)} · step {step.step} of {step.cycleLength}</li>;
        })}
      </ul>}
    </>}
    <Btn small disabled={!onSave} color={joined ? C.muted : C.blue}
      onClick={() => onSave?.(pilotEnrollment(PILOT_ID, joined ? 'left' : 'active'))}>
      {joined ? 'Leave pilot' : 'Join pilot'}
    </Btn>
  </Card>;
}
