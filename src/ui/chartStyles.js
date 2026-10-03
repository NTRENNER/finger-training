import { C } from './theme.js';

// Shared presentation only. Each chart retains its own units, domains and
// interpolation: record staircases must not look like smoothed estimates.
export const CHART = {
  height: 270,
  margin: { top: 12, right: 16, bottom: 10, left: 0 },
  tick: { fill: C.muted, fontSize: 11 },
  tooltip: {
    background: C.card, border: `1px solid ${C.border}`, borderRadius: 8,
    color: C.text, fontSize: 12, lineHeight: 1.5, maxWidth: 'min(320px, calc(100vw - 48px))',
    whiteSpace: 'normal', overflowWrap: 'anywhere',
  },
};
