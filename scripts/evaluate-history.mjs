#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { evaluateHistorical } from '../src/model/historicalEvaluation.js';
try {
  if (!process.argv[2]) throw new Error('Usage: npm run evaluate:history -- /path/to/reps.json');
  console.log(JSON.stringify(evaluateHistorical(JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2));
} catch (error) {
  console.error(error.message); process.exitCode = 1;
}
