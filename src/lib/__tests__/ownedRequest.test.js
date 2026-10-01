import { createOwnedFetch } from '../ownedRequest.js';
import { __setNsUidForTests, setLastUserRaw } from '../storage.js';

const url = 'https://example.supabase.co';
const token = owner => `header.${btoa(JSON.stringify({ sub: owner }))}.signature`;
const headers = owner => ({ authorization: `Bearer ${token(owner)}` });
beforeEach(() => { localStorage.clear(); __setNsUidForTests('a'); setLastUserRaw('a'); });
afterEach(() => __setNsUidForTests(null));

test.each(['reps', 'rpc/update_user_settings_patch', 'tendon_sessions'])(
  'blocks %s when SDK resolved another account token after an earlier auth check', async path => {
    const network = jest.fn();
    const ownedFetch = createOwnedFetch(url, network);
    await expect(ownedFetch(`${url}/rest/v1/${path}`, { headers: headers('b') })).rejects.toThrow('Account changed');
    expect(network).not.toHaveBeenCalled();
  });
test('allows owner requests, but discards a response arriving after a switch', async () => {
  const result = { status: 200 };
  const network = jest.fn().mockResolvedValue(result);
  const ownedFetch = createOwnedFetch(url, network);
  await expect(ownedFetch(`${url}/rest/v1/reps`, { headers: headers('a') })).resolves.toBe(result);
  network.mockImplementationOnce(async () => { setLastUserRaw('b'); return result; });
  await expect(ownedFetch(`${url}/rest/v1/reps`, { headers: headers('a') })).rejects.toThrow('Account changed');
});
test('rejects a stale page even when its token still belongs to it', async () => {
  setLastUserRaw('b');
  const network = jest.fn();
  await expect(createOwnedFetch(url, network)(`${url}/rest/v1/reps`, { headers: headers('a') }))
    .rejects.toThrow('Account changed');
  expect(network).not.toHaveBeenCalled();
});
test.each([{}, { authorization: 'Bearer malformed' }, headers(null)])('fails closed without identifiable ownership', async h => {
  const network = jest.fn();
  await expect(createOwnedFetch(url, network)(`${url}/rest/v1/reps`, { headers: h })).rejects.toThrow();
  expect(network).not.toHaveBeenCalled();
});
test('anonymous local work waits for account adoption and reload', async () => {
  __setNsUidForTests(null);
  const network = jest.fn();
  await expect(createOwnedFetch(url, network)(`${url}/rest/v1/reps`, { headers: headers('a') })).rejects.toThrow();
  expect(network).not.toHaveBeenCalled();
});
test('auth endpoints remain available to sign in and out', async () => {
  __setNsUidForTests(null);
  const network = jest.fn().mockResolvedValue({ status: 200 });
  await createOwnedFetch(url, network)(`${url}/auth/v1/token`, { method: 'POST' });
  expect(network).toHaveBeenCalledTimes(1);
});

test('the real SDK passes its final asynchronously resolved RPC token through the guard', async () => {
  const { createClient } = require('@supabase/supabase-js');
  const network = jest.fn();
  const client = createClient(url, 'test-public-key', {
    accessToken: async () => token('b'),
    global: { fetch: createOwnedFetch(url, network) },
  });
  const { error } = await client.rpc('update_user_settings_patch', { patch: { theme: 'dark' } });
  expect(error).toBeTruthy();
  expect(network).not.toHaveBeenCalled();
});
