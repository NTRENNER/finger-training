// ─────────────────────────────────────────────────────────────
// useUserSettings — App-level user state extracted from App.js
// ─────────────────────────────────────────────────────────────
// Owns the user-configurable + cross-device state that doesn't belong
// to a single tab: display unit, body weight (scalar + per-date log),
// target trip, climbing focus bias for the coaching engine, climbing
// pyramid pin maps (per discipline / venue / wall combo), and the
// per-grip fatigue β model. All have local-first storage with cloud
// reconcile on sign-in.
//
// Extraction rationale (BACKLOG #154): these state slices share the
// same shape — local LS for fast first paint, cloud user_settings row
// (or its own table for BW) as the authority on sign-in. Pulling them
// out of App.js shrinks the orchestrator from 1062 → ~700 lines and
// makes the cloud reconcile patterns easier to read in one place.
// Notes + activities + reps stay in their own homes (notes inline in
// App.js for now; activities → useActivities; reps → useRepHistory).
//
// Hook contract: pass the current `user` (from useAuth). The hook
// fires its cloud reconciles when `user` flips null → signed-in and
// silently no-ops otherwise. Returns a flat object of getter/setter
// pairs the parent threads into views. `setFatigueModel` is exposed
// (not just a saveFatigueModel) because the post-session refresh in
// App.js needs to apply a server-trigger update without going through
// the cloud-push path.

import { useState, useEffect, useCallback } from "react";
import {
  loadLS, saveLS,
  LS_BW_LOG_KEY,
  LS_PYRAMID_PROJECT_KEY,
  LS_PINNED_GRIP_BASELINES_KEY,
  migrateLegacyPyramidPins,
} from "../lib/storage.js";
import { today } from "../util.js";
import { DEFAULT_TRIP } from "../lib/trip.js";
import {
  pushBW, fetchBWLog,
  fetchUserSettings, pushUserSettings,
} from "../lib/sync.js";
import { defaultFatigueModel } from "../model/fatigueBeta.js";

// Hook-internal LS keys. These used to be defined at the top of App.js
// but every consumer was inside this hook's scope, so the constants
// follow the state they describe. The "ft_*" prefix is shared with
// keys in src/lib/storage.js; kept here rather than promoted there
// because nothing else reads or writes them.
const LS_BW_KEY             = "ft_bw";              // body weight in kg (number)
const LS_TRIP_KEY           = "ft_trip";            // { date: "YYYY-MM-DD", name }
const LS_CLIMBING_FOCUS_KEY = "ft_climbing_focus";  // "balanced" | "bouldering" | "power_endurance" | "endurance"

export function useUserSettings({ user }) {
  // ── Unit preference ───────────────────────────────────────
  const [unit, setUnit] = useState(() => loadLS("unit_pref") || "lbs");
  const saveUnit = useCallback((u) => {
    setUnit(u);
    saveLS("unit_pref", u);
  }, []);

  // ── Body weight ───────────────────────────────────────────
  // Two storage keys: LS_BW_KEY is the scalar current weight that
  // every consumer reads, LS_BW_LOG_KEY is the per-date history that
  // the trends + per-session-date normalization paths consume. saveBW
  // writes to both. On boot we hydrate the scalar from the latest log
  // entry when it's missing — handles the case where cloud sync only
  // restored the log (or the scalar got cleared independently). Without
  // this guard the F-D chart's BW-relative toggle and any future BW
  // normalization stay silently hidden even though the data is present.
  const [bodyWeight, setBodyWeight] = useState(() => {
    const scalar = loadLS(LS_BW_KEY);
    if (scalar != null) return scalar;
    const log = loadLS(LS_BW_LOG_KEY) || [];
    if (log.length === 0) return null;
    const latest = [...log].sort((a, b) => a.date < b.date ? -1 : 1).at(-1);
    const kg = latest?.kg ?? null;
    if (kg != null) saveLS(LS_BW_KEY, kg);  // hydrate so subsequent loads are O(1)
    return kg;
  });
  const saveBW = useCallback((kg) => {
    setBodyWeight(kg);
    saveLS(LS_BW_KEY, kg);
    if (kg != null) {
      const log = loadLS(LS_BW_LOG_KEY) || [];
      const d = today();
      // Replace existing entry for today if present, otherwise append
      const updated = log.filter(e => e.date !== d);
      saveLS(LS_BW_LOG_KEY, [...updated, { date: d, kg }].sort((a, b) => a.date < b.date ? -1 : 1));
      // Best-effort cloud push (fire-and-forget). Failures are
      // logged but otherwise silent — the local write is already
      // durable, and the next sign-in reconcile will catch any
      // entries that didn't make it to the server.
      pushBW(d, kg);
    }
  }, []);

  // ── BW cloud reconcile ───────────────────────────────────
  // Runs when `user` flips from null → signed-in. Mirrors the
  // useRepHistory reconcile pattern: fetch cloud log, union with
  // local log on date-key (later-write wins for same-day collisions —
  // we trust local since the user just opened the app there), save
  // the merged set back to LS, and re-derive the scalar from the
  // latest entry. Also fires a push for any local-only entries the
  // cloud doesn't yet know about, so a previously-offline device's
  // BW history gets backfilled on first sign-in.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const cloud = await fetchBWLog();
      if (cancelled || !cloud) return;
      const local = loadLS(LS_BW_LOG_KEY) || [];
      // Merge: same-date local wins (assumption: local is the device
      // the user is actively using, so its writes are most recent).
      const byDate = new Map();
      for (const e of cloud) byDate.set(e.date, e);
      for (const e of local) byDate.set(e.date, e);
      const merged = [...byDate.values()].sort((a, b) => a.date < b.date ? -1 : 1);
      saveLS(LS_BW_LOG_KEY, merged);
      // Hydrate the scalar from the latest merged entry.
      const latest = merged.at(-1);
      if (latest?.kg > 0) {
        setBodyWeight(latest.kg);
        saveLS(LS_BW_KEY, latest.kg);
      }
      // Backfill any local-only entries to the cloud (one push per
      // missing date). Fire-and-forget; same as saveBW's push path.
      const cloudDates = new Set(cloud.map(e => e.date));
      for (const e of local) {
        if (!cloudDates.has(e.date) && e.kg > 0) pushBW(e.date, e.kg);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  // ── Trip (user-editable target trip) ──────────────────────
  const [trip, setTrip] = useState(() => {
    const stored = loadLS(LS_TRIP_KEY);
    return (stored && typeof stored === "object" && stored.date) ? stored : DEFAULT_TRIP;
  });
  const saveTrip = useCallback((next) => {
    setTrip(prev => {
      const merged = { ...prev, ...next };
      saveLS(LS_TRIP_KEY, merged);
      return merged;
    });
  }, []);

  // ── Climbing focus (cloud-synced training goal bias) ──────
  // "balanced" (default), "bouldering", "power_endurance", "endurance"
  // — feeds focusBoost() in coaching.js with gentle multipliers
  // (1.10–1.20× boost, 0.90× de-emphasis) that nudge close calls.
  // Strong signals (curve-coverage debt, recent climbing fatigue)
  // still dominate; this is intentionally a tiebreaker, not an
  // override. Synced to user_settings so the selection follows the
  // user across devices.
  const [climbingFocus, setClimbingFocusState] = useState(() => {
    const stored = loadLS(LS_CLIMBING_FOCUS_KEY);
    return (typeof stored === "string" && stored) ? stored : "balanced";
  });
  const saveClimbingFocus = useCallback((next) => {
    setClimbingFocusState(next);
    saveLS(LS_CLIMBING_FOCUS_KEY, next);
    // Fire-and-forget cloud push so cross-device sync is automatic.
    // Merge with existing cloud settings so we don't clobber any
    // future keys the user has set.
    if (user) {
      (async () => {
        const current = (await fetchUserSettings()) || {};
        await pushUserSettings({ ...current, climbing_focus: next });
      })().catch(() => {});
    }
  }, [user]);

  // ── Climbing pyramid project pin (per filter combination) ──
  // Stored as a { [composite-key]: grade } map where the key is
  // `${discipline}|${venue}|${wall}` (built via pyramidPinKey). Each
  // (boulder, indoor, commercial) vs (boulder, indoor, moonboard)
  // vs (boulder, outdoor, all) etc. gets its own slot because V4 on
  // a MoonBoard isn't the same climb as V4 on a commercial set.
  //
  // Synced to user_settings.pyramid_project so the pin follows the
  // user across devices. Local LS is the read cache for fast first
  // paint; cloud is the authority. Legacy discipline-keyed pins get
  // migrated to composite shape on load so existing users don't lose
  // their previous pins.
  //
  // (A `pyramid_warmup` companion map existed when the pyramid card
  // had a "Warmups ≤ Vx" floor selector — May 2026. The redesigned
  // 5-tier silhouette doesn't filter by warmup, so the map and its
  // sync were removed. Any leftover values on `user_settings.pyramid_
  // warmup` and `localStorage[LS_PYRAMID_WARMUP_KEY]` are now ignored,
  // harmless, and can be cleared by a future migration if desired.)
  const [pyramidProjectMap, setPyramidProjectMapState] = useState(
    () => migrateLegacyPyramidPins(loadLS(LS_PYRAMID_PROJECT_KEY))
  );
  const savePyramidProjectMap = useCallback((next) => {
    setPyramidProjectMapState(next);
    saveLS(LS_PYRAMID_PROJECT_KEY, next);
    if (user) {
      (async () => {
        const current = (await fetchUserSettings()) || {};
        await pushUserSettings({ ...current, pyramid_project: next });
      })().catch(() => {});
    }
  }, [user]);

  // ── Pinned per-grip baselines ─────────────────────────────
  // The frozen { [grip]: { date, amps } } map that anchors Curve
  // Improvement. Once a grip's baseline is seeded (≥5 failures × ≥3
  // distinct durations), it gets written here and never re-derived
  // unless explicitly cleared. Prevents stale-device-sync backdating
  // from shifting the comparison frame retroactively.
  //
  // See LS_PINNED_GRIP_BASELINES_KEY's comment for the why. useGripFits
  // owns the pin-on-first-seed effect; this hook is just the storage
  // wiring (LS + cloud round-trip).
  const [pinnedGripBaselines, setPinnedGripBaselinesState] = useState(
    () => loadLS(LS_PINNED_GRIP_BASELINES_KEY) || {}
  );
  const savePinnedGripBaselines = useCallback((next) => {
    setPinnedGripBaselinesState(next);
    saveLS(LS_PINNED_GRIP_BASELINES_KEY, next);
    if (user) {
      (async () => {
        const current = (await fetchUserSettings()) || {};
        await pushUserSettings({ ...current, pinned_grip_baselines: next });
      })().catch(() => {});
    }
  }, [user]);

  // ── Fatigue β model (per-grip) ───────────────────────────
  // Stored in user_settings.settings.fatigue_model so it persists
  // across devices. Updated server-side by the
  // update_fatigue_beta_from_rep_trg trigger on every rep-1 insert;
  // the client re-fetches user_settings on sign-in to pick up changes.
  // See src/model/fatigueBeta.js for the math.
  //
  // setFatigueModel is exposed so App.js's post-session refresh
  // (after the server trigger fires) can apply the new value without
  // going through a cloud round-trip from this hook's perspective.
  const [fatigueModel, setFatigueModel] = useState(() => defaultFatigueModel());

  // Pull climbing focus + pyramid pins + fatigue model from cloud on
  // sign-in. Cloud-wins for scalars/maps that already exist on the
  // cloud row — keeps cross-device state coherent without a more
  // elaborate merge protocol.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const cloud = await fetchUserSettings();
      if (cancelled || !cloud) return;
      const cf = cloud.climbing_focus;
      if (typeof cf === "string" && cf) {
        setClimbingFocusState(cf);
        saveLS(LS_CLIMBING_FOCUS_KEY, cf);
      }
      // Pyramid project pin — apply if cloud has it. Migration runs
      // on the cloud side too so a row last written under the legacy
      // discipline-keyed shape gets normalized before it lands in
      // local state. (cloud.pyramid_warmup is ignored as of the
      // warmup-floor removal — see comment above the pin map state.)
      if (cloud.pyramid_project && typeof cloud.pyramid_project === "object") {
        const migrated = migrateLegacyPyramidPins(cloud.pyramid_project);
        setPyramidProjectMapState(migrated);
        saveLS(LS_PYRAMID_PROJECT_KEY, migrated);
      }
      // Pinned grip baselines — frozen { [grip]: {date, amps} } map.
      // Cloud-wins for the same reason as pyramid pins: the user might
      // have seeded baselines on a different device and we want those
      // to follow them, not get clobbered by a freshly-computed local
      // baseline from a leaner local rep history.
      if (cloud.pinned_grip_baselines && typeof cloud.pinned_grip_baselines === "object") {
        setPinnedGripBaselinesState(cloud.pinned_grip_baselines);
        saveLS(LS_PINNED_GRIP_BASELINES_KEY, cloud.pinned_grip_baselines);
      }
      // Pull fatigue_model so the client uses the same β the server
      // trigger is updating. Falls back to local defaults if cloud
      // has no value yet (first-run before any rep-1 insert).
      if (cloud.fatigue_model && typeof cloud.fatigue_model === "object") {
        setFatigueModel(cloud.fatigue_model);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  return {
    unit, saveUnit,
    bodyWeight, saveBW,
    trip, saveTrip,
    climbingFocus, saveClimbingFocus,
    pyramidProjectMap, savePyramidProjectMap,
    pinnedGripBaselines, savePinnedGripBaselines,
    fatigueModel, setFatigueModel,
  };
}
