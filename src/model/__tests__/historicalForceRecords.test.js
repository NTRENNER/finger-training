import { historicalForceRecords, historicalForceTimeline } from '../historicalForceRecords.js';
import { measureSustainedMax, sustainedMaxKg } from '../sustainedMax.js';

const hold = (kg, extra = {}) => ({ grip: 'Crusher', hand: 'L', date: '2026-09-20',
  actual_time_s: 4.1, avg_force_kg: kg, load_provenance: 'measured_force', failure_valid: true, ...extra });
const window = (kg, extra = {}) => ({ grip: 'Crusher', hand: 'L', date: '2026-10-02',
  force_recording: { sustained_max: measureSustainedMax(Array.from({length: 21}, (_, i) => ({ts:i*100,kg}))) }, ...extra });

test('all history contributes even when older holds predate the two-second field', () => {
  const old = hold(72, {date:'2025-01-01'}), recent = window(18.8);
  const before = JSON.stringify([old,recent]);
  expect(historicalForceRecords([recent,old])[0]).toMatchObject({
    best:{kg:72,durationS:4.1,date:'2025-01-01',basis:'hold_average'},
    twoSecond:{kg:18.8,durationS:2,date:'2026-10-02',basis:'two_second_window'},
    trackingSince:'2026-10-02',
  });
  expect(sustainedMaxKg(old)).toBeNull();
  expect(JSON.stringify([old,recent])).toBe(before);
});

test('subsequent lower results never erase historical records', () => {
  const rows=[hold(72),window(18.8),window(17,{date:'2026-10-03'}),hold(20,{date:'2026-10-03'})];
  expect(historicalForceRecords(rows)[0].best.kg).toBe(72);
  expect(historicalForceRecords(rows.reverse())[0].twoSecond.kg).toBeCloseTo(18.8);
});

test('records are separate by grip and hand and accept extra sets', () => {
  const rows=[hold(72),hold(60,{hand:'R'}),hold(25,{grip:'Micro'}),hold(73,{set_num:2})];
  expect(historicalForceRecords(rows).map(r=>[r.grip,r.hand,r.best.kg]))
    .toEqual([['Crusher','L',73],['Crusher','R',60],['Micro','L',25]]);
});

test.each([
  {actual_time_s:1.9}, {actual_time_s:Infinity}, {avg_force_kg:200},
  {avg_force_kg:null,prescribed_load_kg:90}, {load_provenance:'nominal_setting'},
  {load_provenance:'prescription_only'}, {failure_valid:false}, {end_reason:'equipment_interruption'},
  {force_recording:{signal_quality:'incomplete'}}, {force_recording:{continuity:'intermittent'}},
  {load_provenance:undefined,peak_force_kg:72},
])('unusable historical averages cannot become records: %j', patch => {
  expect(historicalForceRecords([hold(72,patch)])).toEqual([]);
});

test('legacy sensor averages are included without claiming a reconstructed window', () => {
  const r=hold(72,{load_provenance:undefined,peak_force_kg:74.1});
  expect(historicalForceRecords([r])[0]).toMatchObject({best:{kg:72,basis:'hold_average'},twoSecond:null,trackingSince:null});
});

test('a verified window can set a new record even if the larger effort was interrupted', () => {
  const r=window(80,{failure_valid:false,end_reason:'equipment_interruption'});
  expect(historicalForceRecords([hold(72),r])[0].best).toMatchObject({kg:80,basis:'two_second_window',durationS:2});
});


test('full-history chart steps up only on a new record, without backfilling a later hand', () => {
  const records = historicalForceRecords([
    hold(40, {date:'2026-04-01'}), hold(60, {date:'2026-05-01'}),
    hold(50, {date:'2026-05-01'}), hold(30, {date:'2026-10-02'}),
    hold(55, {date:'2026-06-01',hand:'R'}), hold(45, {date:'2026-10-02',hand:'R'}),
  ].reverse());
  const timeline = historicalForceTimeline(records);
  expect(timeline.map(p => [p.date,p.series0,p.series1])).toEqual([
    ['2026-04-01',40,null], ['2026-05-01',60,null],
    ['2026-06-01',60,55], ['2026-10-02',60,55],
  ]);
  expect(timeline[3].record0.date).toBe('2026-05-01');
  expect(timeline[0].timestamp).toBe(Date.parse('2026-04-01T12:00:00Z'));
});

test('unqualified early training remains on the axis without inventing a max', () => {
  const timeline = historicalForceTimeline(historicalForceRecords([
    hold(100,{date:'2026-01-01',actual_time_s:1}),hold(40),
  ]));
  expect(timeline[0].series0).toBeNull();
  expect(timeline[1].series0).toBe(40);
  expect(historicalForceTimeline([])).toEqual([]);
});


test('relative records rank by bodyweight ratio and never fall when absolute force sets a new high', () => {
  const rows = [hold(60, {date:'2026-04-01'}), hold(65, {date:'2026-05-01'}), hold(70, {date:'2026-06-01'})];
  const bw = {'2026-04-01':60,'2026-05-01':80,'2026-06-01':65};
  const relative = record => record.kg / bw[record.date];
  const records = historicalForceRecords(rows, relative);
  expect(records[0].best.kg).toBe(70);
  expect(historicalForceTimeline(records).map(p => relative(p.record0))).toEqual([1,1,70/65]);
  expect(historicalForceRecords(rows)[0].progress.map(p=>p.best.kg)).toEqual([60,65,70]);
});
