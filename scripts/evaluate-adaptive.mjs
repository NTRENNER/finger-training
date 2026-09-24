#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { evaluateAdaptiveCapacity } from '../src/model/adaptiveCapacityEvaluation.js';
try {
  if (!process.argv[2]) throw new Error('Usage: npm run evaluate:adaptive -- /path/to/reps.json');
  console.log(JSON.stringify(evaluateAdaptiveCapacity(JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2));
} catch (error) {
  console.error(error.stack || error.message); process.exitCode = 1;
}
