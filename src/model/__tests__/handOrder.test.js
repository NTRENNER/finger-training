import { startingHandForDay } from '../handOrder.js';

const row = (date, hand, first) => ({ date, hand, actual_time_s: 3,
  force_recording: first ? { hand_order: { first_hand: first } } : null });

test('rotation follows training days, not elapsed calendar days', () => {
  expect(startingHandForDay([], '2026-09-24')).toBe('L');
  const history = [row('2026-09-20', 'L', 'L'), row('2026-09-20', 'R', 'L')];
  expect(startingHandForDay(history, '2026-09-20')).toBe('L');
  expect(startingHandForDay(history, '2026-09-24')).toBe('R');
  history.push(row('2026-09-24', 'R', 'R'));
  expect(startingHandForDay(history, '2026-09-24')).toBe('R');
  expect(startingHandForDay(history, '2026-10-04')).toBe('L');
});

test('warmup peak, interrupted attempts, and other grips retain one daily order after reload', () => {
  const history = [row('2026-09-24', 'R', 'R'), { ...row('2026-09-24', 'L', 'R'), grip: 'Crusher', failure_valid: false }];
  expect(startingHandForDay(JSON.parse(JSON.stringify(history)).reverse(), '2026-09-24')).toBe('R');
  expect(startingHandForDay(history, '2026-09-25')).toBe('L');
});

test('opening or cancelling without a pull does not rotate; legacy two-hand order is left first', () => {
  const history = [row('2026-09-20', 'R'), row('2026-09-20', 'L'), { ...row('2026-09-24', 'R', 'R'), actual_time_s: 0 }];
  expect(startingHandForDay(history, '2026-09-20')).toBe('L');
  expect(startingHandForDay(history, '2026-09-24')).toBe('R');
  expect(startingHandForDay(history, '2026-09-25')).toBe('R');
});

test('synthetic seed artifacts do not advance the training day', () => {
  const seed = { date:'2026-09-23', hand:'L', actual_time_s:30, avg_force_kg:12, peak_force_kg:12 };
  expect(startingHandForDay([seed], '2026-09-24')).toBe('L');
});
