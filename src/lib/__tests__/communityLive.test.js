import { subscribeCommunity } from '../communityLive.js';
import { supabase } from '../supabase.js';
import { ownsLocalSession } from '../sync.js';
jest.mock('../supabase.js', () => ({ supabase: { realtime: { setAuth: jest.fn() }, channel: jest.fn(), removeChannel: jest.fn() } }));
jest.mock('../sync.js', () => ({ ownsLocalSession: jest.fn() }));
let channel, change, status;
beforeEach(() => {
  ownsLocalSession.mockReturnValue(true);
  supabase.realtime.setAuth.mockResolvedValue(null);
  supabase.removeChannel.mockResolvedValue(null);
  channel = { on: jest.fn((type, config, callback) => { change = callback; return channel; }),
    subscribe: jest.fn(callback => { status = callback; return channel; }) };
  supabase.channel.mockReturnValue(channel);
});
test('private invalidations have no payload dependency and subscription reconnect refreshes data', async () => {
  const onChange = jest.fn(), onStatus = jest.fn();
  const close = subscribeCommunity('a', onChange, onStatus);
  await Promise.resolve();
  expect(supabase.channel).toHaveBeenCalledWith('community', { config: { private: true } });
  status('SUBSCRIBED'); change({ arbitrary: 'ignored' });
  expect(onChange).toHaveBeenCalledTimes(2);
  expect(onChange).toHaveBeenLastCalledWith();
  expect(onStatus).toHaveBeenLastCalledWith('live');
  close(); change(); status('SUBSCRIBED');
  expect(onChange).toHaveBeenCalledTimes(2);
  expect(supabase.removeChannel).toHaveBeenCalledWith(channel);
});
test('account change prevents callbacks from an old live connection', async () => {
  const onChange = jest.fn(), onStatus = jest.fn();
  const close = subscribeCommunity('a', onChange, onStatus);
  await Promise.resolve();
  ownsLocalSession.mockReturnValue(false);
  change(); status('SUBSCRIBED');
  expect(onChange).not.toHaveBeenCalled(); expect(onStatus).not.toHaveBeenCalled();
  close();
});
test('cleanup while authentication is pending cannot create a late subscription', async () => {
  let finish;
  supabase.realtime.setAuth.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const close = subscribeCommunity('a', jest.fn(), jest.fn());
  close(); finish(); await Promise.resolve();
  expect(supabase.channel).not.toHaveBeenCalled();
});
test('failed socket/auth uses refresh fallback rather than claiming live status', async () => {
  const onStatus = jest.fn();
  supabase.realtime.setAuth.mockRejectedValue(new Error('offline'));
  subscribeCommunity('a', jest.fn(), onStatus);
  await Promise.resolve(); await Promise.resolve();
  expect(onStatus).toHaveBeenCalledWith('refreshing');
});
