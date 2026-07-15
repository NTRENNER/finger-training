// ──────────────────────────────────────────────────────────────
// TREND LINE
// ──────────────────────────────────────────────────────────────
// Least-squares linear fit over an index axis (0..n-1) — a simple
// "are you trending up or down" line for otherwise-spiky per-session
// series (e.g. the climbing v-sum charts). Returns the fitted y at
// each index (same length as input), or null with fewer than 2 usable
// points. Non-finite inputs are treated as gaps and excluded from the
// fit but still get an interpolated fitted value from the line.
export function linearTrendline(values) {
  const pts = [];
  (values || []).forEach((v, i) => {
    if (v == null) return;          // null/undefined are gaps, not zeros
    const y = Number(v);
    if (Number.isFinite(y)) pts.push([i, y]);
  });
  if (pts.length < 2) return null;
  const n = pts.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return (values || []).map((_, i) => intercept + slope * i);
}
