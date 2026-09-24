#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { evaluateForward } from '../src/model/forwardEvaluation.js';
const path = process.argv[2];
if (!path) {
  console.error('Usage: npm run evaluate:forward -- /path/to/reps.json [--details]');
  process.exit(2);
}
try {
  const report = evaluateForward(JSON.parse(readFileSync(path, 'utf8')));
  if (!process.argv.includes('--details')) delete report.observations;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
