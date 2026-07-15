// useTendon — SHARED store for the tendon-protocol completion log.
//
// Previously each caller (the Setup card, the History list) ran its own
// useTendon() with private state, so they each fetched independently and
// logging in one didn't update the other until a manual refetch. This is
// now a single module-level store read through useSyncExternalStore, so
// every consumer sees one cache: one fetch, and a log/delete anywhere
// updates every view live. Still self-contained (auth via tendonSync)
// and separate from the reps model.
import { useSyncExternalStore, useCallback } from "react";
import { fetchTendonSessions, pushTendonSession, deleteTendonSession } from "../lib/tendonSync.js";
import { uuid, today } from "../util.js";

// ── Module store ──────────────────────────────────────────────
let state = { sessions: [], loaded: false };
const listeners = new Set();
let fetchStarted = false;

function emit() { for (const l of listeners) l(); }
function setState(patch) { state = { ...state, ...patch }; emit(); }
function getSnapshot() { return state; }

function subscribe(listener) {
  listeners.add(listener);
  // Lazily kick off the one-and-only initial load on first subscription.
  if (!fetchStarted) { fetchStarted = true; reloadStore(); }
  return () => listeners.delete(listener);
}

// ── Store mutators (exported so tests can drive them without React) ──
export async function reloadStore() {
  const rows = await fetchTendonSessions();
  if (rows) setState({ sessions: rows, loaded: true });
  else setState({ loaded: true });          // fetch failed — mark loaded so UIs stop spinning
}

// Log a completed session. Optimistically inserts, then pushes to the
// cloud. On success the store is reconciled from the server and
// { ok: true } is returned; on failure the optimistic row is rolled
// back and { ok: false } is returned so the UI can offer a retry
// (using the SAME record, so a retry doesn't create a duplicate id).
export async function logTendonSession(input) {
  const rec = input.id ? input : {
    id: uuid(),
    date: today(),
    preset: input.preset,
    sets: input.sets,
    total_work_s: input.totalWorkS,
    work_sec: input.workSec ?? null,
    rest_sec: input.restSec ?? null,
    effort_pct: input.effortPct ?? null,
  };
  setState({ sessions: [rec, ...state.sessions.filter(s => s.id !== rec.id)] });   // optimistic
  const ok = await pushTendonSession(rec);
  if (ok) { reloadStore(); return { ok: true, rec }; }
  setState({ sessions: state.sessions.filter(s => s.id !== rec.id) });             // roll back
  return { ok: false, rec };
}

// Delete a session. Optimistically removes, then deletes in the cloud.
// On failure the row is restored (via an authoritative reload) and
// { ok: false } is returned so the caller can surface the error.
export async function removeTendonSession(id) {
  setState({ sessions: state.sessions.filter(s => s.id !== id) });   // optimistic
  const ok = await deleteTendonSession(id);
  if (ok) { reloadStore(); return { ok: true }; }
  reloadStore();                                                     // restore from server
  return { ok: false };
}

export function useTendon() {
  const snap = useSyncExternalStore(subscribe, getSnapshot);
  const logSession    = useCallback((args) => logTendonSession(args), []);
  const removeSession = useCallback((id)   => removeTendonSession(id), []);
  return { sessions: snap.sessions, loaded: snap.loaded, logSession, removeSession, reload: reloadStore };
}

// Test-only: reset the module store between tests (there's one singleton
// for the whole app, so tests that assert on store contents need a clean
// slate). Not used by app code.
export function __resetTendonStore() {
  state = { sessions: [], loaded: false };
  listeners.clear();
  fetchStarted = false;
}
