#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { evaluateCapacityWindows } from '../src/model/capacityWindowExperiment.js';
try {
  if (!process.argv[2]) throw new Error('Usage: npm run evaluate:windows -- /path/to/reps.json');
  console.log(JSON.stringify(evaluateCapacityWindows(JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2));
} catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
