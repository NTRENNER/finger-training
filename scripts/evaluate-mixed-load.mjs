#!/usr/bin/env node
// Read-only report; the export stays local and is never sent to a service.
import { readFileSync } from 'node:fs';
import { summarizeMixedPredictions } from '../src/model/mixedLoadPrediction.js';
const path = process.argv[2];
if (!path) {
  console.error('Usage: npm run evaluate:mixed -- /path/to/reps.json');
  process.exit(2);
}
try {
  const rows = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(rows)) throw new Error('Expected a JSON array of rep rows');
  console.log(JSON.stringify(summarizeMixedPredictions(rows), null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
