import { getStorageUserId, readRawLastUser } from './storage.js';

// This is an account-consistency check, not authentication. Supabase still
// verifies the token and enforces RLS. Check at the fetch boundary because
// the SDK resolves its access token asynchronously, after a caller's guard.
function tokenOwner(headers) {
  try {
    const token = new Headers(headers).get('authorization')?.replace(/^Bearer\s+/i, '');
    const part = token?.split('.')[1];
    if (!part) return null;
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))).sub || null;
  } catch {
    return null;
  }
}

function ownerMatches(owner) {
  return Boolean(owner) && getStorageUserId() === owner && readRawLastUser() === owner;
}

export function createOwnedFetch(supabaseUrl, fetchImpl = (...args) => fetch(...args)) {
  const api = new URL(supabaseUrl);
  return async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    // Auth endpoints must remain available for signing in/out and adoption.
    if (url.origin !== api.origin || !url.pathname.startsWith('/rest/v1/')) {
      return fetchImpl(input, init);
    }
    const owner = getStorageUserId();
    const headers = init?.headers ?? input?.headers;
    if (!ownerMatches(owner) || tokenOwner(headers) !== owner) {
      throw new Error('Account changed; keep this work in its original local account.');
    }
    const response = await fetchImpl(input, init);
    if (!ownerMatches(owner)) {
      // A request already sent with A's token may have completed for A. Do not
      // acknowledge it or return its data to a page transitioning accounts.
      throw new Error('Account changed while syncing; retry from the original account.');
    }
    return response;
  };
}
