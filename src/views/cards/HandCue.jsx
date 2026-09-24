import React from 'react';
import { C } from '../../ui/theme.js';

// Shared by training and Peak Test so every hand change looks familiar.
export function HandCue({ hand }) {
  return <div aria-live="polite">
    <div style={{ fontSize: 13, color: C.muted, letterSpacing: 1.2,
      textTransform: 'uppercase', marginBottom: 4 }}>Use your</div>
    <div style={{ fontSize: 32, fontWeight: 900, color: hand === 'R' ? C.orange : C.blue, marginBottom: 14 }}>
      {hand === 'R' ? '✋ Right Hand' : '🤚 Left Hand'}
    </div>
  </div>;
}
