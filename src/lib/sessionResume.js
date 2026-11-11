// Session resume. A running finger session is held in memory, so a reload
// (or the phone closing the app) used to end it: finished reps were saved,
// but the rest had to be started again as a new session. The runner now
// writes its place here after every step and reads it back on start.
//
// Scope, on purpose:
//   • Ordinary sessions only. Chaos Machine, Volume Beta and Peak Test keep
//     models built from pre-session history that cannot be restored exactly.
//   • The frozen plan (prescription, decision record, cookedness adjustment)
//     is saved and restored verbatim, so resumed reps are stamped exactly as
//     they would have been.
//   • Forecast models are NOT restored. Rebuilding them after a reload would
//     use history that already contains this session's reps. Resumed reps
//     therefore carry no prediction check rather than a leaky one.
//   • A snapshot is used only on the day it was written and within
//     SESSION_RESUME_MAX_AGE_MS. Anything older is dropped silently.
import { loadLS, saveLS } from "./storage.js";

export const LS_SESSION_RESUME_KEY = "ft_session_resume";
// Version 1 discarded pending-redo identity and the within-set rest clock.
// It cannot be resumed safely; completed history remains untouched.
export const SESSION_RESUME_VERSION = 2;
export const SESSION_RESUME_MAX_AGE_MS = 30 * 60 * 1000;

// Phases a session can be picked up in. A rep in progress cannot be
// recovered, so it resumes at "ready for the rep". Rest keeps its wall-clock
// origin; the existing rest view handles elapsed time and release checks.
const RESUME_PHASE = {
  offset_prompt: "offset_prompt",
  rep_ready: "rep_ready",
  rep_active: "rep_ready",
  resting: "resting",
  switch_hands: "switch_hands",
  between_sets: "between_sets",
};

export const canResumeConfig = config =>
  Boolean(config?.grip) && !config.mixedDomainPlan && !config.peakTest && !config.volumePlan;

export function saveSessionSnapshot(state, nowMs = Date.now()) {
  if (!RESUME_PHASE[state.phase] || !canResumeConfig(state.config) || !state.sessionId) return false;
  saveLS(LS_SESSION_RESUME_KEY, {
    version: SESSION_RESUME_VERSION,
    savedAtMs: nowMs,
    phase: RESUME_PHASE[state.phase],
    config: state.config,
    sessionId: state.sessionId,
    sessionStartedAt: state.sessionStartedAt,
    sessionDate: state.sessionDate,
    refWeights: state.refWeights,
    currentSet: state.currentSet,
    currentRep: state.currentRep,
    activeHand: state.activeHand,
    firstHand: state.firstHand,
    manualOffset: state.manualOffset,
    // Whether the Tindeq was in use, so a resumed session can offer to
    // reconnect it (a reload always drops the Bluetooth link).
    tindeq: state.tindeqConnected === true || state.tindeqWanted === true,
    repIds: state.sessionReps.map(r => r.id),
    retryRecord: state.retryRecord ?? null,
    retryTargetKg: state.retryTargetKg ?? null,
    // The force recording already lives in history. Retain the UI result and
    // its exact rest origin without duplicating that potentially large trace.
    lastRepResult: state.lastRepResult ? { ...state.lastRepResult, forceRecording: undefined } : null,
    sessionAdjustment: state.sessionAdjustment ?? null,
    sessionPrescription: state.sessionPrescription ?? {},
    sessionDecision: state.sessionDecision ?? null,
    lastActivityByHand: state.lastActivityByHand ?? {},
    setRest: state.setRest ?? null,
  });
  return true;
}

export function clearSessionSnapshot() {
  if (loadLS(LS_SESSION_RESUME_KEY) != null) saveLS(LS_SESSION_RESUME_KEY, null);
}

// Returns the snapshot plus its rep records, or null when there is nothing
// safe to resume. `history` is the current rep history; every rep the
// session had recorded must still be in it.
export function readSessionSnapshot(history, { nowMs = Date.now(), todayYmd } = {}) {
  const snap = loadLS(LS_SESSION_RESUME_KEY);
  if (!snap) return null;
  const usable = snap.version === SESSION_RESUME_VERSION
    && RESUME_PHASE[snap.phase]
    && canResumeConfig(snap.config)
    && typeof snap.sessionId === "string" && snap.sessionId
    && Number.isFinite(snap.savedAtMs)
    && nowMs - snap.savedAtMs >= 0 && nowMs - snap.savedAtMs <= SESSION_RESUME_MAX_AGE_MS
    && (!todayYmd || snap.sessionDate === todayYmd)
    && Array.isArray(snap.repIds);
  if (!usable) { clearSessionSnapshot(); return null; }
  const byId = new Map((history || []).map(r => [r.id, r]));
  const reps = snap.repIds.map(id => byId.get(id));
  if (reps.some(r => !r || r.session_id !== snap.sessionId)) { clearSessionSnapshot(); return null; }
  if (snap.retryRecord) {
    const retry = snap.retryRecord;
    const stored = byId.get(retry.id);
    // Do not resurrect a deleted attempt, overwrite a completed retry, or
    // attach the retry to a different slot after an edit on another device.
    if (!stored || !stored.force_recording?.redo_pending || snap.repIds.includes(retry.id)
        || stored.session_id !== snap.sessionId || retry.session_id !== snap.sessionId
        || stored.set_num !== retry.set_num || stored.rep_num !== retry.rep_num || stored.hand !== retry.hand
        || Number(retry.set_num) !== snap.currentSet || Number(retry.rep_num) !== snap.currentRep + 1
        || retry.hand !== snap.activeHand) {
      clearSessionSnapshot(); return null;
    }
  }
  if (snap.phase === 'resting' && (!reps.length || !snap.lastRepResult
      || !(snap.lastRepResult.restStartedAtMs === null || Number.isFinite(snap.lastRepResult.restStartedAtMs)))) {
    clearSessionSnapshot(); return null;
  }
  return { ...snap, reps, lastRepResult: snap.lastRepResult
    ? { ...snap.lastRepResult, forceRecording: reps.at(-1)?.force_recording } : null };
}
