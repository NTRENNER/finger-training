import { enqueueRepSlotDeletions, flushRepSlotDeletions, pendingRepSlotDeletions } from '../repSlotDeletionQueue.js';
import { pushRepSlotTombstones } from '../sync.js';
jest.mock('../sync.js', () => ({
  pushRepSlotTombstones: jest.fn(),
  repSlotKey: r => `${r.session_id}|${r.set_num}|${r.rep_num}|${r.hand}`,
}));
const slot = rep_num => ({ session_id: 's', set_num: 1, rep_num, hand: 'L' });
beforeEach(() => localStorage.clear());

test('failed uploads remain durable and duplicates do not multiply the queue', async () => {
  enqueueRepSlotDeletions([slot(1), slot(1), {}]);
  pushRepSlotTombstones.mockResolvedValue(false);
  await flushRepSlotDeletions();
  expect(pendingRepSlotDeletions()).toEqual([slot(1)]);
  pushRepSlotTombstones.mockResolvedValue(true);
  await flushRepSlotDeletions();
  expect(pendingRepSlotDeletions()).toEqual([]);
});

test('an in-flight acknowledgement cannot discard a newly queued slot', async () => {
  let resolve;
  pushRepSlotTombstones.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  enqueueRepSlotDeletions([slot(1)]);
  const pending = flushRepSlotDeletions();
  enqueueRepSlotDeletions([slot(2)]);
  resolve(true);
  await pending;
  expect(pendingRepSlotDeletions()).toEqual([slot(2)]);
  pushRepSlotTombstones.mockResolvedValue(true);
  await flushRepSlotDeletions();
  expect(pendingRepSlotDeletions()).toEqual([]);
});
