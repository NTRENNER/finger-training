#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {evaluateContextualTrends} from '../src/model/contextualTrendEvaluation.js';
if(!process.argv[2])throw new Error('Usage: node scripts/evaluate-contextual-trends.mjs /path/to/reps.json');
console.log(JSON.stringify(evaluateContextualTrends(JSON.parse(readFileSync(process.argv[2],'utf8'))),null,2));
