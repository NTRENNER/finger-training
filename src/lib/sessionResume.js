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
export const SESSION_RESUME_VERSION = 1;
export const SESSION_RESUME_MAX_AGE_MS = 30 * 60 * 1000;

// Phases a session can be picked up in. A rep in progress cannot be
// recovered, so it and a finished rest both resume at "ready for the rep".
const RESUME_PHASE = {
  offset_prompt: "offset_prompt",
  rep_ready: "rep_ready",
  rep_active: "rep_ready",
  resting: "rep_ready",
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
  return { ...snap, reps };
}
