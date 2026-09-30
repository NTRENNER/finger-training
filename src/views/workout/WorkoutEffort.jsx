import React from 'react';
import { C } from '../../ui/theme.js';

export function WorkoutEffort({ name, data, onChange }) {
  if (!data?.sets?.some(s => s.done)) return null;
  return <fieldset style={{ border: 0, padding: '8px 0 16px', margin: 0 }}>
    <legend style={{ color: C.muted, fontSize: 13 }}>How did {name} feel? (optional)</legend>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {[['could_do_more', 'Could do more'], ['about_right', 'About right'], ['at_limit', 'At my limit']].map(([value, label]) =>
        <button key={value} type="button" aria-pressed={data.effort === value}
          onClick={() => onChange(data.effort === value ? null : value)}
          style={{ borderRadius: 8, border: `1px solid ${C.border}`, padding: '9px 12px',
            background: data.effort === value ? C.blue : C.bg, color: C.text, cursor: 'pointer' }}>{label}</button>)}
    </div>
  </fieldset>;
}
