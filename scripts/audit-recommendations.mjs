#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { auditRecommendations } from '../src/model/recommendationAudit.js';
try {
  if (!process.argv[2]) throw new Error('Usage: npm run audit:recommendations -- /path/to/reps.json [--months]');
  const report = auditRecommendations(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  if (!process.argv.includes('--months')) for (const a of Object.values(report.athletes)) delete a.byMonth;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error.stack || error.message); process.exitCode = 1;
}
