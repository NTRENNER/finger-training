import React, { useId } from 'react';
import './Toggle.css';

/** A keyboard-operable switch with one shared visual treatment. */
export function Toggle({ label, checked, onChange, disabled = false, description, className = '' }) {
  const descriptionId = useId();
  return <div className={`app-toggle ${className}`}>
    <button type="button" role="switch" aria-label={label} aria-checked={Boolean(checked)}
      aria-describedby={description ? descriptionId : undefined} disabled={disabled}
      className="app-toggle-control" onClick={() => onChange?.(!checked)}>
      <span className="app-toggle-track" aria-hidden="true"><span className="app-toggle-thumb" /></span>
      <span className="app-toggle-label">{label}</span>
    </button>
    {description && <p className="app-toggle-description" id={descriptionId}>{description}</p>}
  </div>;
}
