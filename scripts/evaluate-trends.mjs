#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { evaluateCapacityTrends } from '../src/model/capacityTrendExperiment.js';
try {
  if (!process.argv[2]) throw new Error('Usage: npm run evaluate:trends -- /path/to/reps.json');
  console.log(JSON.stringify(evaluateCapacityTrends(JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2));
} catch (error) {
  console.error(error.stack || error.message); process.exitCode = 1;
}
