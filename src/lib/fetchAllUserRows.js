import { supabase } from './supabase.js';
import { getStorageUserId, readRawLastUser } from './storage.js';

const ownsLocalSession = owner => Boolean(owner)
  && getStorageUserId() === owner && readRawLastUser() === owner;

// A single select is capped by the Data API. Walk the immutable primary key
// rather than offsets: inserts/deletions cannot shift the remaining pages.
// Read through an empty page, even if the server uses a smaller page limit.
export async function fetchAllUserRows(table) {
  const owner = getStorageUserId();
  const rows = [];
  let after = null;
  try {
    while (ownsLocalSession(owner)) {
      let query = supabase.from(table).select('*').eq('user_id', owner)
        .order('id', { ascending: true }).limit(500);
      if (after !== null) query = query.gt('id', after);
      const { data, error } = await query;
      if (error || !ownsLocalSession(owner)) return null;
      if (!Array.isArray(data)) return null;
      if (data.length === 0) return rows;
      const last = data[data.length - 1].id;
      if (!last || (after !== null && last <= after)) return null;
      rows.push(...data);
      after = last;
    }
  } catch (error) {
    console.warn(`${table} download:`, error?.message);
  }
  // Never hand a partial history to reconciliation after a failed page.
  return null;
}
