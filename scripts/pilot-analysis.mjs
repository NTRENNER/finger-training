#!/usr/bin/env node
// Emphasis-block pilot report for one athlete (docs/emphasis-block-protocol.md).
// Input: a JSON export, either { reps, activities, workouts } or a plain reps
// array. Exports hold personal data: keep them in scripts/data/ (ignored).
//   npm run pilot:analysis -- scripts/data/a1.json [--json] [--as-of YYYY-MM-DD]
import { readFileSync } from 'node:fs';
import { pilotReport } from '../src/model/pilotAnalysis.js';

const pc = v => v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const range = c => c?.change == null ? `—${c ? ` (${c.days} day${c.days === 1 ? '' : 's'})` : ''}`
  : `${pc(c.change)} (${pc(c.low)} to ${pc(c.high)}; ${c.n} on ${c.days} days)`;

function summary(report) {
  const lines = [`Pilot ${report.pilot} · data to ${report.as_of} · analysis v${report.version}`, ''];
  lines.push(`Yardstick: fresh openers before ${report.yardstick.cutoff}, curve model v${report.yardstick.curve_version}`);
  for (const [grip, hands] of Object.entries(report.yardstick.curves)) {
    lines.push(`  ${grip}: ${Object.entries(hands).map(([h, c]) => `${h} ${c.n} openers on ${c.days} days`).join(', ')}`);
  }
  lines.push('', 'Change across each window, vs the yardstick (90% day-bootstrap range):');
  for (const w of report.windows) {
    lines.push(`  ${w.label} (${w.start} to ${w.end})`);
    lines.push(`    short end: ${range(report.ends[w.id].short.all)}`);
    lines.push(`    long end:  ${range(report.ends[w.id].long.all)}`);
    lines.push(`    peak:      ${range(report.peaks[w.id].all)}`);
    lines.push(`    whole curve (refit on the window's openers): ${pc(report.balanced[w.id].change)}`);
    for (const [grip, e] of Object.entries(report.exposure[w.id])) {
      lines.push(`    ${grip}: ${e.sessions} sessions, ${e.holds} holds (${e.long_end_holds} long-end), ${Math.round(e.tut_s / 60)} min under load`);
    }
  }
  if (report.fixed_load.length) {
    lines.push('', 'Same-load repeats (first-rep hold time):');
    for (const f of report.fixed_load) {
      lines.push(`  ${f.window} ${f.grip} ${f.hand} ${f.target_s}s @ ${f.load_kg} kg: ${f.first.t_s}s (${f.first.date}) → ${f.last.t_s}s (${f.last.date}) ${pc(f.change)}`);
    }
  }
  const { blocks, mismatched } = report.background.comparison;
  lines.push('', 'Background load, weekly means by block:');
  for (const b of blocks) {
    lines.push(`  ${b.id} (${b.weeks} weeks): ${Object.entries(b.means).map(([k, v]) => `${k} ${v ?? '—'}`).join(', ')}`);
  }
  lines.push(`  differing by more than 25%: ${mismatched.length ? mismatched.join(', ') : 'none'}`);
  return lines.join('\n');
}

try {
  const file = process.argv.slice(2).find(arg => !arg.startsWith('--') && !/^\d{4}-\d{2}-\d{2}$/.test(arg));
  if (!file) throw new Error('Usage: npm run pilot:analysis -- /path/to/export.json [--json] [--as-of YYYY-MM-DD]');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const input = Array.isArray(data) ? { reps: data } : data;
  const asOfIndex = process.argv.indexOf('--as-of');
  const report = pilotReport(input, { asOf: asOfIndex > 0 ? process.argv[asOfIndex + 1] : null });
  console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : summary(report));
} catch (error) {
  console.error(error.stack || error.message); process.exitCode = 1;
}
