import { act, renderHook, waitFor } from '@testing-library/react';
import { useCommunity } from './useCommunity.js';
import { loadLS, saveLS } from '../lib/storage.js';
import { ownsLocalSession } from '../lib/sync.js';
import { ensureCommunityProfile, saveCommunityProfile, syncCommunity } from '../lib/communityApi.js';
import { subscribeCommunity } from '../lib/communityLive.js';
jest.mock('../lib/communityLive.js', () => ({ subscribeCommunity: jest.fn() }));
jest.mock('../lib/storage.js', () => ({ loadLS: jest.fn(), saveLS: jest.fn() }));
jest.mock('../lib/sync.js', () => ({ ownsLocalSession: jest.fn() }));
jest.mock('../lib/communityApi.js', () => ({ ensureCommunityProfile: jest.fn(), saveCommunityProfile: jest.fn(), syncCommunity: jest.fn() }));
const profile = { user_id: 'a', sharing_enabled: true, display_name: 'Climber A', created_at: '2026-11-01T00:00:00Z' };
let storage;
beforeEach(() => {
  subscribeCommunity.mockReturnValue(() => {});
  storage = new Map();
  loadLS.mockImplementation(key => storage.get(key));
  saveLS.mockImplementation((key, value) => { storage.set(key, value); return true; });
  ownsLocalSession.mockImplementation(owner => owner === 'a');
  ensureCommunityProfile.mockResolvedValue(profile);
  saveCommunityProfile.mockImplementation(async (owner, patch) => ({ ...profile, ...patch }));
  syncCommunity.mockResolvedValue(null);
});
const initialProps = { user: { id: 'a' }, isOnline: true, syncSignal: 0, live: true };
test('automatic publications are idempotent and keep the same owner', async () => {
  const { result } = renderHook(useCommunity, { initialProps });
  await waitFor(() => expect(result.current.profile).toEqual(profile));
  await act(async () => { await result.current.publish([], []); await result.current.publish([], []); });
  expect(syncCommunity).toHaveBeenCalledTimes(1);
  expect(syncCommunity).toHaveBeenCalledWith('a', [], [], []);
});
test('offline opt-out is durable, suppresses publishing immediately, then syncs on reconnection', async () => {
  storage.set('ft_community_profile', profile);
  const { result, rerender } = renderHook(useCommunity, { initialProps: { ...initialProps, isOnline: false } });
  act(() => result.current.update({ sharing_enabled: false }));
  expect(result.current.sharing).toBe(false);
  expect(result.current.pending).toBe(true);
  expect(storage.get('ft_community_preferences_pending')).toEqual({ sharing_enabled: false });
  await act(async () => { await result.current.publish([], []); });
  expect(syncCommunity).not.toHaveBeenCalled();
  rerender(initialProps);
  await waitFor(() => expect(result.current.pending).toBe(false));
  expect(saveCommunityProfile).toHaveBeenCalledWith('a', { sharing_enabled: false });
  expect(result.current.sharing).toBe(false);
});
test('failed opt-out stays pending, never reports synced or publishes more cards', async () => {
  saveCommunityProfile.mockRejectedValue(new Error('offline'));
  const { result } = renderHook(useCommunity, { initialProps });
  await waitFor(() => expect(result.current.profile).toEqual(profile));
  act(() => result.current.update({ sharing_enabled: false }));
  await waitFor(() => expect(result.current.error).toBeTruthy());
  expect(result.current.pending).toBe(true);
  await act(async () => { await result.current.publish([], []); });
  expect(syncCommunity).not.toHaveBeenCalled();
});
test('an older acknowledged preference cannot discard a newer choice', async () => {
  let finish;
  saveCommunityProfile.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(useCommunity, { initialProps });
  await waitFor(() => expect(result.current.profile).toEqual(profile));
  act(() => result.current.update({ sharing_enabled: false }));
  await waitFor(() => expect(saveCommunityProfile).toHaveBeenCalledTimes(1));
  act(() => result.current.update({ sharing_enabled: true }));
  ensureCommunityProfile.mockResolvedValue({ ...profile, sharing_enabled: false });
  await act(async () => finish({ ...profile, sharing_enabled: false }));
  await waitFor(() => expect(saveCommunityProfile).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.pending).toBe(false));
  expect(result.current.sharing).toBe(true);
});
test('a failed publish retries after reconnect, without changing training or profile data', async () => {
  syncCommunity.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(null);
  const { result, rerender } = renderHook(useCommunity, { initialProps });
  await waitFor(() => expect(result.current.profile).toEqual(profile));
  await act(async () => { await result.current.publish([], []); });
  expect(result.current.error).toBeTruthy();
  rerender({ ...initialProps, syncSignal: 1 });
  await waitFor(() => expect(result.current.error).toBe(''));
  await act(async () => { await result.current.publish([], []); });
  expect(syncCommunity).toHaveBeenCalledTimes(2);
  expect(saveCommunityProfile).not.toHaveBeenCalled();
});
test('anonymous users and changed account namespaces cannot enroll or publish', async () => {
  const { result } = renderHook(useCommunity, { initialProps: { ...initialProps, user: { id: 'a', is_anonymous: true } } });
  await act(async () => { await result.current.publish([], []); });
  expect(ensureCommunityProfile).not.toHaveBeenCalled();
  expect(syncCommunity).not.toHaveBeenCalled();
});
test('startup with a cached namespace and no authenticated user cannot enroll or crash', () => {
  ownsLocalSession.mockReturnValue(true);
  const { result } = renderHook(useCommunity, { initialProps: { ...initialProps, user: null } });
  expect(result.current.owner).toBeNull();
  expect(ensureCommunityProfile).not.toHaveBeenCalled();
});
test('a different account cannot render cached profile data or publish its history', async () => {
  storage.set('ft_community_profile', profile);
  const { result } = renderHook(useCommunity, { initialProps: { ...initialProps, user: { id: 'b' } } });
  expect(result.current.owner).toBeNull();
  expect(result.current.profile).toBeNull();
  await act(async () => { await result.current.publish([], []); });
  expect(syncCommunity).not.toHaveBeenCalled();
});
test('storage failure does not falsely report an opt-out as saved', async () => {
  const { result } = renderHook(useCommunity, { initialProps });
  await waitFor(() => expect(result.current.profile).toEqual(profile));
  saveLS.mockReturnValue(false);
  act(() => result.current.update({ sharing_enabled: false }));
  expect(result.current.error).toMatch(/Could not save/);
  expect(result.current.sharing).toBe(true);
  expect(saveCommunityProfile).not.toHaveBeenCalled();
});
test('live invalidations coalesce and never cause a publish feedback loop', async () => {
  const { result } = renderHook(useCommunity, { initialProps });
  await waitFor(() => expect(result.current.profile).toEqual(profile));
  await act(async () => { await result.current.publish([], [], [{ metric: 'power' }]); });
  const [, onChange, onStatus] = subscribeCommunity.mock.calls[0];
  act(() => { onStatus('live'); onChange(); onChange(); onChange(); });
  expect(result.current.liveStatus).toBe('live');
  await waitFor(() => expect(ensureCommunityProfile).toHaveBeenCalledTimes(2));
  await act(async () => { await result.current.publish([], [], [{ metric: 'power' }]); });
  expect(syncCommunity).toHaveBeenCalledTimes(1);
});
test('remote opt-out is reflected locally after invalidation', async () => {
  const { result } = renderHook(useCommunity, { initialProps });
  await waitFor(() => expect(result.current.profile).toEqual(profile));
  ensureCommunityProfile.mockResolvedValue({ ...profile, sharing_enabled: false });
  act(() => subscribeCommunity.mock.calls[0][1]());
  await waitFor(() => expect(result.current.sharing).toBe(false));
  await act(async () => { await result.current.publish([], []); });
  expect(syncCommunity).not.toHaveBeenCalled();
});
test('fallback refreshes missed events and all timers/subscriptions stop on unmount', async () => {
  jest.useFakeTimers();
  try {
    const unsubscribe = jest.fn(); subscribeCommunity.mockReturnValue(unsubscribe);
    const { result, unmount } = renderHook(useCommunity, { initialProps });
    await waitFor(() => expect(result.current.profile).toEqual(profile));
    await act(async () => { jest.advanceTimersByTime(15200); });
    expect(ensureCommunityProfile).toHaveBeenCalledTimes(2);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await act(async () => { jest.advanceTimersByTime(30000); });
    expect(ensureCommunityProfile).toHaveBeenCalledTimes(2);
  } finally { jest.useRealTimers(); }
});
test('away from the Community tab nothing polls or subscribes, and opening it starts live updates', async () => {
  jest.useFakeTimers();
  try {
    const { result, rerender } = renderHook(useCommunity, { initialProps: { ...initialProps, live: false } });
    await waitFor(() => expect(result.current.profile).toEqual(profile));
    await act(async () => { jest.advanceTimersByTime(60000); });
    expect(subscribeCommunity).not.toHaveBeenCalled();
    expect(ensureCommunityProfile).toHaveBeenCalledTimes(1);
    rerender(initialProps);
    expect(subscribeCommunity).toHaveBeenCalledTimes(1);
    await act(async () => { jest.advanceTimersByTime(15200); });
    expect(ensureCommunityProfile).toHaveBeenCalledTimes(2);
  } finally { jest.useRealTimers(); }
});
