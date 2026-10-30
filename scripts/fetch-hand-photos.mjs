#!/usr/bin/env node
// Download new hand photos (HO device sizing) from the private Supabase
// bucket into a local folder, by default HO Files/Hand Photos in iCloud.
//
//   npm run hand-photos
//
// Needs SUPABASE_SERVICE_ROLE_KEY in .env.local (never commit it; .env.* is
// git-ignored). Set HAND_PHOTOS_DIR to download somewhere else. Files that
// are already there are skipped, so it's safe to run any time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { BUCKET, localPathFor } from '../src/hands/handUpload.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['.env.local', '.env']) {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

const url = process.env.REACT_APP_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Add SUPABASE_SERVICE_ROLE_KEY to .env.local (Supabase dashboard → Project Settings → API keys → service_role).');
  process.exit(1);
}
const dest = process.env.HAND_PHOTOS_DIR
  || path.join(os.homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/Personal/3D Prints/HO Files/Hand Photos');

const storage = createClient(url, key, { auth: { persistSession: false } }).storage.from(BUCKET);

async function walk(prefix) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await storage.list(prefix, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error(`Listing ${prefix || 'the bucket'} failed: ${error.message}`);
    for (const entry of data) {
      const full = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) out.push(...await walk(full));     // a folder
      else out.push({ path: full, size: entry.metadata?.size });
    }
    if (data.length < 1000) return out;
  }
}

const objects = await walk('');
let fetched = 0;
const people = new Set();
for (const object of objects) {
  const relative = localPathFor(object.path);
  if (!relative) continue;
  const target = path.join(dest, relative);
  if (fs.existsSync(target) && fs.statSync(target).size === object.size) continue;
  const { data, error } = await storage.download(object.path);
  if (error) { console.error(`Couldn't download ${object.path}: ${error.message}`); continue; }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from(await data.arrayBuffer()));
  fetched += 1;
  people.add(relative.split('/')[0]);
  console.log(`  ${relative}`);
}
console.log(fetched
  ? `Downloaded ${fetched} photo${fetched === 1 ? '' : 's'} (${[...people].join(', ')}) to ${dest}`
  : `No new photos. (${dest})`);
