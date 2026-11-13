// Isolated, in-memory PostgreSQL: never connects to Supabase or user data.
// npm install --prefix /tmp/finger-community-tools --no-audit --no-fund @electric-sql/pglite@0.5.16
// PGLITE_MODULE=/tmp/finger-community-tools/node_modules/@electric-sql/pglite/dist/index.js node scripts/verify-community-db.mjs
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE).href : '@electric-sql/pglite');
const db = new PGlite();
let checks = 0;
const check = (value, expected, message) => { assert.deepEqual(value, expected, message); checks++; };
const query = async (sql, params = []) => (await db.query(sql, params)).rows;
const denied = async (sql, params = []) => { await assert.rejects(() => query(sql, params)); checks++; };
const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
await db.exec(`create schema auth;
  create role authenticated; create role anon;
  create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select jsonb_build_object('is_anonymous', current_setting('test.anonymous', true) = 'true') $$;
  grant usage on schema auth, public to authenticated, anon;
  create schema realtime;
  create table realtime.messages (payload jsonb, event text, topic text, private boolean);
  alter table realtime.messages enable row level security;
  grant usage on schema realtime to authenticated, anon;
  grant select, insert on realtime.messages to authenticated;
  create function realtime.topic() returns text language sql stable as $$ select current_setting('test.topic', true) $$;
  create function realtime.send(payload jsonb, event text, topic text, private boolean) returns void
    language sql as $$ insert into realtime.messages values (payload,event,topic,private) $$;
  insert into auth.users values ('${a}'), ('${b}');`);
await db.exec(await readFile(new URL('../supabase/migrations/20261111215512_community_achievements.sql', import.meta.url), 'utf8'));
// Simulate existing permissive realtime rules; this topic must stay protected.
await db.exec(`create policy unrelated_broad_read on realtime.messages for select to authenticated using (true);
  create policy unrelated_broad_send on realtime.messages for insert to authenticated with check (true);`);
await db.exec('set role authenticated');
async function member(id, anonymous = false) {
  await query("select set_config('test.uid', $1, false), set_config('test.anonymous', $2, false)", [id, String(anonymous)]);
}
await member(a);
await query('insert into public.community_profiles(user_id,display_name) values ($1,$2)', [a, 'Climber A']);
await denied('insert into public.community_profiles(user_id,display_name) values ($1,$2)', [b, 'Imposter']);
await denied("update public.community_profiles set created_at = now() - interval '1 year' where user_id = $1", [a]);
await member(b);
await query('insert into public.community_profiles(user_id,display_name) values ($1,$2)', [b, 'Climber B']);
check((await query('select * from public.community_profiles')).length, 2, 'enabled aliases visible to members');
check((await query("update public.community_profiles set display_name = 'Hacked' where user_id = $1 returning user_id", [a])).length, 0, 'cannot edit another member');
await member(a);
const stamp = new Date(Date.now() + 1000).toISOString();
const card = { achievement_key: 'v1|test|1', grip: 'Crusher', metric: 'power', milestone_pct: 1,
  improvement_pct: 1.4, baseline_date: '2026-01-01', prior_date: '2026-02-01', achieved_date: new Date().toISOString().slice(0, 10),
  occurred_at: stamp, baseline_force_kg: 40, current_force_kg: 40.56, support_keys: ['power'] };
const peaks = [{ grip: 'Crusher', hand: 'L', peak_kg: 50.123456789, measured_date: '2026-03-01' },
  { grip: 'Crusher', hand: 'R', peak_kg: 49, measured_date: '2026-03-01' }];
const sync = (cards, records = peaks) => query('select public.sync_community($1::jsonb,$2::jsonb)', [JSON.stringify(cards), JSON.stringify(records)]);
await sync([card]);
await sync([card]);
check((await query('select * from public.community_achievements')).length, 1, 'idempotent publication');
let feed = await query('select * from public.community_feed()');
check(feed.length, 1, 'published snapshot visible');
const id = feed[0].id;
let rank = await query("select * from public.community_ranking('Crusher')");
check(rank.length, 1, 'best hand gives one row per member');
check(rank[0].peak_kg, 50.123456789, 'ranking preserves full force precision');
check((await query("select * from public.community_ranking('Crusher','R')"))[0].peak_kg, 49, 'hand filter');
await member(b);
await query('insert into public.community_celebrations values ($1,$2) on conflict do nothing', [id, b]);
await query('insert into public.community_celebrations values ($1,$2) on conflict do nothing', [id, b]);
feed = await query('select * from public.community_feed()');
check(Number(feed[0].celebrations), 1, 'duplicate celebration idempotent');
check(feed[0].celebrated, true, 'own celebration returned');
await denied('insert into public.community_celebrations values ($1,$2)', [id, a]);
await sync([], [{ grip: 'Crusher', hand: 'R', peak_kg: peaks[0].peak_kg, measured_date: '2026-03-02' }]);
rank = await query("select * from public.community_ranking('Crusher')");
check(rank.map(r => Number(r.place)), [1, 1], 'exact ties share rank');
check((await query('update public.community_achievements set hidden = true where id = $1 returning id', [id])).length, 0, 'cannot hide another member');
await member(a);
await query('update public.community_achievements set hidden = true where id = $1', [id]);
await sync([card]);
check((await query('select * from public.community_feed()')).length, 0, 'hidden card not republished');
await member(b);
check((await query('select * from public.community_achievements')).length, 0, 'hidden card protected in direct reads');
check((await query('select * from public.community_celebrations')).length, 0, 'hidden card reactions protected');
await member(a);
await query('update public.community_achievements set hidden = false where id = $1', [id]);
await sync([], []);
check((await query('select * from public.community_feed()')).length, 0, 'removed source withdraws card');
check((await query("select * from public.community_ranking('Crusher')")).some(r => r.user_id === a), false, 'removed peak evidence removed');
await sync([card]);
await query('update public.community_profiles set sharing_enabled = false where user_id = $1', [a]);
await sync([card]);
await member(b);
check((await query('select * from public.community_profiles where user_id = $1', [a])).length, 0, 'opt-out hides profile');
check((await query('select * from public.community_feed()')).length, 0, 'opt-out hides cards');
check((await query("select * from public.community_ranking('Crusher')")).some(r => r.user_id === a), false, 'opt-out hides ranking');
await denied('insert into public.community_celebrations values ($1,$2)', [id, b]);
await member(a);
await query('update public.community_profiles set sharing_enabled = true where user_id = $1', [a]);
await denied('select public.sync_community($1::jsonb,$2::jsonb)', [JSON.stringify([{ ...card, achievement_key: 'invalid', improvement_pct: 0.9 }]), JSON.stringify(peaks)]);
check((await query('select * from public.community_feed()')).length, 1, 'invalid batch rolls back withdrawal atomically');
await sync([{ ...card, achievement_key: 'old', occurred_at: '2026-01-01T00:00:00Z' }]);
check((await query('select * from public.community_feed()')).length, 0, 'no historical backfill');
await sync([{ ...card, achievement_key: 'imported-old', achieved_date: '2026-03-01' }]);
check((await query('select * from public.community_feed()')).length, 0, 'new timestamp on old training date does not backfill');
const support = ['max_strength','power','power_strength','strength','strength_endurance','endurance'];
const progress = { grip: 'Crusher', metric: 'balanced', baseline_date: '2026-01-01',
  prior_date: '2026-11-01', measured_date: '2026-11-11', baseline_force_kg: 35, current_force_kg: 38.5,
  group_force_kg: 35, improvement_pct: 10, milestone_pct: 5, support_keys: support };
const syncProgress = rows => query('select public.sync_community($1::jsonb,$2::jsonb,$3::jsonb)', ['[]','[]',JSON.stringify(rows)]);
const board = (band = 30, basis = support, grip = 'Crusher') => query('select * from public.community_improvement_ranking($1,$2,$3::text[])', [grip,band,basis]);
await syncProgress([progress, { ...progress, metric: 'power' }]);
await syncProgress([progress, { ...progress, metric: 'power' }]);
check((await board()).length, 2, 'live snapshots are idempotent per member/domain');
await member(b);
await syncProgress([{ ...progress, improvement_pct: 12, current_force_kg: 39.2 }]);
check((await board()).filter(r => r.metric === 'balanced').map(r => r.user_id), [b,a], 'latest gain controls rank');
check(Number((await query("select * from public.community_improvement_groups('Crusher')"))[0].members), 2, 'cohorts count distinct members across domains');
check((await board(30,support,'Prime')).length, 0, 'grips never mix');
await syncProgress([progress]);
check((await board()).filter(r => r.metric === 'balanced').map(r => Number(r.place)), [1,1], 'live exact ties share rank');
await syncProgress([{ ...progress, group_force_kg: 65 }]);
check((await board()).filter(r => r.metric === 'balanced').map(r => r.user_id), [a], 'different starting bands do not mix');
await syncProgress([{ ...progress, support_keys: ['max_strength','power'] }]);
check((await board()).filter(r => r.metric === 'balanced').map(r => r.user_id), [a], 'different curve coverage does not mix');
check((await board(30,['max_strength','power'])).map(r => r.user_id), [b], 'alternate coverage has its own board');
check((await query('delete from public.community_progress where user_id = $1 returning user_id',[a])).length, 0, 'cannot delete another member ranking');
await denied('insert into public.community_progress(user_id,grip,metric,baseline_date,prior_date,measured_date,baseline_force_kg,current_force_kg,group_force_kg,improvement_pct,milestone_pct,support_keys) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
  [a,'Prime','balanced',progress.baseline_date,progress.prior_date,progress.measured_date,35,38.5,35,10,5,support]);
await member(a);
await denied('select public.sync_community($1::jsonb,$2::jsonb,$3::jsonb)', ['[]','[]',JSON.stringify([progress,progress])]);
check((await board()).length, 2, 'duplicate input rolls back snapshot replacement');
await query("select set_config('test.topic','community',false)");
const eventsBefore = Number((await query('select count(*) from realtime.messages'))[0].count);
check(eventsBefore > 0, true, 'committed changes broadcast invalidations');
check((await query("select * from realtime.messages where payload <> '{}'::jsonb or event <> 'changed' or topic <> 'community' or not private")).length, 0, 'broadcasts carry no names, scores, identifiers or training records');
await query('update public.community_profiles set sharing_enabled = false where user_id = $1',[a]);
await member(b);
check((await board()).length, 0, 'opt-out hides all progress immediately');
check(Number((await query('select count(*) from realtime.messages'))[0].count) > eventsBefore, true, 'opt-out still invalidates other clients after visibility is removed');
await denied("insert into realtime.messages values ('{}','changed','community',true)");
await denied('select community_private.notify_change()');
await member(a);
await query('update public.community_profiles set sharing_enabled = true where user_id = $1',[a]);
await syncProgress([]);
check((await board()).length, 0, 'removed or disputed sources retract live rankings');
await member(b, true);
check((await query('select * from realtime.messages')).length, 0, 'anonymous auth blocked despite broad existing realtime policy');
check((await board(30,['max_strength','power'])).length, 0, 'anonymous auth cannot read progress rankings');
check((await query('select * from public.community_profiles')).length, 0, 'anonymous auth cannot read profiles');
check((await query("select * from public.community_ranking('Crusher')")).length, 0, 'anonymous auth cannot read ranking');
await denied('select public.sync_community($1::jsonb,$2::jsonb)', ['[]', '[]']);
await db.exec('set role anon');
await denied('select * from public.community_profiles');
await denied('select * from public.community_feed()');
// Upgrade a populated database: old clients/rows must remain usable without
// inventing missing baselines, then exercise the new improvement-only RPC.
await db.exec('reset role');
await db.exec(await readFile(new URL('../supabase/migrations/20261112122110_community_peak_improvement.sql', import.meta.url), 'utf8'));
// Both members joined before every comparison date below.
await db.exec("update public.community_profiles set created_at = '2025-12-15T12:00:00Z'");
await db.exec('set role authenticated');
await member(a);
const peakBoard = (hand = null, grip = 'Crusher') => query('select * from public.community_peak_improvement_ranking($1,$2)', [grip,hand]);
check((await peakBoard()).length, 0, 'existing absolute peaks never acquire invented gains');
const improvedPeak = { grip: 'Crusher', hand: 'L', peak_kg: 60, measured_date: '2026-03-01',
  baseline_peak_kg: 40, baseline_date: '2026-01-01', improvement_peak_kg: 50, improvement_date: '2026-02-01' };
await sync([], [improvedPeak, { ...improvedPeak, hand: 'R', peak_kg: 110, baseline_peak_kg: 100, improvement_peak_kg: 110 }]);
await sync([], [improvedPeak, { ...improvedPeak, hand: 'R', peak_kg: 110, baseline_peak_kg: 100, improvement_peak_kg: 110 }]);
check((await peakBoard()).length, 1, 'repeat publication keeps one improvement per member');
check((await peakBoard())[0].hand, 'L', 'most improved hand wins even when weaker');
check((await peakBoard())[0].peak_kg, 50, 'comparison does not borrow a larger non-max-intent peak');
check((await peakBoard('R'))[0].peak_kg, 110, 'hand filter uses that hand baseline');
check((await peakBoard(null, 'Prime')).length, 0, 'improvement grip filter');
await member(b);
await sync([], [{ ...improvedPeak, baseline_peak_kg: 100, peak_kg: 110, improvement_peak_kg: 110 }]);
check((await peakBoard()).map(r => r.user_id), [a,b], 'larger percentage gain outranks highest absolute force');
check((await peakBoard()).map(r => Number(r.place)), [1,2], 'gain defines ordinal rank');
await sync([], [{ ...improvedPeak, baseline_peak_kg: 80, peak_kg: 100, improvement_peak_kg: 100 }]);
check((await peakBoard()).map(r => Number(r.place)), [1,1], 'equal percentages at different forces tie');
await sync([], [{ ...improvedPeak, baseline_peak_kg: 80, peak_kg: 100.0000001, improvement_peak_kg: 100.0000001 }]);
check((await peakBoard()).map(r => r.user_id), [b,a], 'unrounded percentage determines order');
const beforeJoin = { ...improvedPeak, baseline_peak_kg: 10, peak_kg: 60, improvement_peak_kg: 50 };
await sync([], [{ ...beforeJoin, baseline_date: '2025-12-13' }]);
check((await peakBoard()).map(r => r.user_id), [a], 'a baseline before joining is never ranked');
await sync([], [{ ...beforeJoin, baseline_date: '2025-12-14' }]);
check((await peakBoard()).map(r => r.user_id), [b,a], 'one day of time-zone slack before the join date');
await sync([], peaks);
check((await peakBoard()).map(r => r.user_id), [a], 'old-client publication cannot appear as fabricated improvement');
await denied('insert into public.community_peaks(user_id,grip,hand,peak_kg,measured_date,baseline_peak_kg,baseline_date,improvement_peak_kg,improvement_date) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
  [a,'Prime','R',50,'2026-03-01',40,'2026-01-01',50,'2026-02-01']);
await member(a);
for (const patch of [{ baseline_peak_kg: 0 }, { baseline_date: null }, { improvement_date: improvedPeak.baseline_date },
  { improvement_peak_kg: 61 }, { improvement_peak_kg: 39 }, { improvement_date: '2099-01-01' }]) {
  await denied('select public.sync_community($1::jsonb,$2::jsonb)', ['[]', JSON.stringify([{ ...improvedPeak, ...patch }])]);
}
check((await peakBoard())[0].improvement_pct, 25, 'invalid comparison rolls back replacement');
await query('update public.community_profiles set sharing_enabled = false where user_id = $1', [a]);
await member(b);
check((await peakBoard()).length, 0, 'opt-out hides new peak improvement RPC');
await member(a);
await query('update public.community_profiles set sharing_enabled = true where user_id = $1', [a]);
await sync([], []);
check((await peakBoard()).length, 0, 'removed or disputed sources retract peak gains');
await sync([], [improvedPeak]);
await member(b, true);
check((await peakBoard()).length, 0, 'anonymous authenticated user cannot see peak improvements');
await db.exec('set role anon');
await denied("select * from public.community_peak_improvement_ranking('Crusher')");
console.log(`Community PostgreSQL: ${checks} checks passed. In-memory database only.`);
await db.close();
