import React from 'react';
import { Toggle } from '../../ui/Toggle.jsx';

export function VolumeBetaEnrollment({ grips, selectedGrips, onGripsChange, onStart, onCancel, busy, error }) {
  return <section className="volume-beta-panel" aria-label="Set up Volume Beta">
    <h3>Try two sets for six weeks</h3>
    <p>Choose the grips you want to include. Aim for three sessions per week for each grip: 18 sessions per grip over six weeks.</p>
    <div role="group" aria-label="Grips in Volume Beta">
      {grips.map(grip => <Toggle key={grip} label={grip} checked={selectedGrips.includes(grip)} disabled={busy}
        onChange={checked => onGripsChange(checked ? [...selectedGrips, grip] : selectedGrips.filter(g => g !== grip))} />)}
    </div>
    <p>Each session has two sets per hand, using your normal domain and 4–5–6 hold progression. Each hand has a five-minute rest target between sets, including time spent training the other hand.</p>
    <p>Your earlier training supplies the starting comparison automatically. Limited or inconsistent history will be marked provisional. The experiment compares measured progress and training cost; it does not promise that more sets work better.</p>
    <div className="volume-beta-actions">
      <button type="button" className="volume-beta-primary" disabled={!selectedGrips.length || busy} onClick={onStart}>
        {busy ? 'Starting…' : 'Start Volume Beta'}
      </button>
      <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </section>;
}

export function VolumeBetaSummary({ experiment, progress, status, grip, enabled, chaosEnabled,
  onSetupAnother, canSetupAnother }) {
  if (!experiment) return null;
  const selected = experiment.grips?.includes(grip);
  const provisional = experiment.baseline?.byHand?.some(row => row.provisional);
  const finished = status === 'completed' || status === 'ended';
  return <section className="volume-beta-panel volume-beta-summary" aria-label="Volume Beta progress">
    <div className="volume-beta-summary-heading">
      <strong>{finished ? 'Volume Beta finished' : status === 'paused' ? 'Volume Beta paused' : `Volume Beta · week ${progress?.week || 1} of 6`}</strong>
      <a href="/research">{finished ? 'Review results' : 'Research'}</a>
    </div>
    {progress?.byGrip?.length > 0 && <ul>
      {progress.byGrip.map(row => <li key={row.grip}>{row.grip}: {row.completed || 0} of {row.goal || 18} complete sessions</li>)}
    </ul>}
    {enabled && <p>Two sets per hand · five minutes between sets for each hand. Your usual domain choices and hold progression stay available.</p>}
    {!finished && status === 'active' && chaosEnabled && <p>Your Volume plan continues. This workout uses Chaos Machine and will not count as a two-set Volume session.</p>}
    {!finished && status === 'active' && selected && !enabled && !chaosEnabled && <p>Volume is not selected for this workout. Your six-week plan continues; turn on Volume for an eligible ordinary session.</p>}
    {!finished && !selected && <p>This plan includes {experiment.grips?.join(' and ')}. {grip} uses its usual session.</p>}
    {status === 'paused' && <p>Resume with the switch above when ready. Pausing keeps your original end date, {experiment.endDate}.</p>}
    {finished && <p>The six-week plan will not extend automatically. Review the results before deciding what to train next.</p>}
    {finished && onSetupAnother && <div className="volume-beta-actions">
      <button type="button" disabled={!canSetupAnother} onClick={onSetupAnother}>Set up another experiment</button>
    </div>}
    {provisional && <p>Your historical starting comparison is provisional; more comparable measurements are needed for a confident conclusion.</p>}
  </section>;
}
