import React, { useEffect, useRef } from 'react';

export function DialogShell({ title, onClose, children }) {
  const closeRef = useRef(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = event => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return <div className="experiment-dialog-backdrop" role="presentation" onMouseDown={event => {
    if (event.target === event.currentTarget) onClose?.();
  }}>
    <section className="experiment-dialog" role="dialog" aria-modal="true" aria-labelledby="experiment-dialog-title">
      <div className="experiment-dialog-heading">
        <h2 id="experiment-dialog-title">{title}</h2>
        <button ref={closeRef} type="button" className="experiment-dialog-close" onClick={onClose}
          aria-label="Close dialog">×</button>
      </div>
      {children}
    </section>
  </div>;
}

export function ExperimentUnlockDialog({ features = [], grip, onChaos, onVolume, onClose }) {
  const hasChaos = features.includes('chaos');
  const hasVolume = features.includes('volume');
  const title = hasChaos && hasVolume ? 'New training options available'
    : hasChaos ? 'Chaos Machine is available'
      : 'Volume Beta is available';

  return <DialogShell title={title} onClose={onClose}>
    <p className="experiment-dialog-intro">
      Your regular recommendation remains the default. These optional protocols are now supported by your {grip} history.
    </p>
    {hasChaos && <div className="experiment-dialog-option">
      <strong>Chaos Machine</strong>
      <p>Train five force-duration domains in one sequence. Only the fresh opening hold updates the curve; later holds measure how performance changes under fatigue.</p>
      <button type="button" className="experiment-dialog-primary" onClick={onChaos}>Preview Chaos session</button>
    </div>}
    {hasVolume && <div className="experiment-dialog-option">
      <strong>Volume Beta</strong>
      <p>Your comparable opening holds show a persistent plateau. This optional six-week trial tests whether a second work set improves progress without changing the prescribed domain.</p>
      <button type="button" className="experiment-dialog-primary" onClick={onVolume}>Review Volume Beta</button>
    </div>}
    <button type="button" className="experiment-dialog-secondary" onClick={onClose}>Keep recommendation</button>
  </DialogShell>;
}
