// ─────────────────────────────────────────────────────────────
// BUILD INFO — runtime-readable bundle identifiers
// ─────────────────────────────────────────────────────────────
// Lets surfaces show "which bundle am I running" without the user
// having to crack open DevTools. Critical for diagnosing cache /
// service-worker / CDN propagation mismatches across devices.
//
// Set at build time by the `build` script in package.json:
//   REACT_APP_BUILD_SHA  — short git SHA (or 'dev' for local dev
//                          builds where git isn't available)
//   REACT_APP_BUILD_TIME — ISO-8601 timestamp of the build
//
// Vercel auto-injects VERCEL_GIT_COMMIT_SHA which the build script
// uses as a fallback when running on their infrastructure.
//
// Why a shared module: the same string appears on Settings (in the
// About section) AND on the corner stamp on WorkoutTab. Without a
// shared helper, the two surfaces could drift (one shows the SHA,
// the other a stale literal — exactly the trap the v.fix.sidekey
// hardcode was in before this module landed).

export const BUILD_SHA = process.env.REACT_APP_BUILD_SHA || "dev";
export const BUILD_TIME = process.env.REACT_APP_BUILD_TIME || null;

// Compact "abc1234 · May 21" display string. Used in the WorkoutTab
// corner stamp where space is tight. Truncates SHA to 7 chars (git
// short-hash convention).
export function shortBuildLabel() {
  const sha = (BUILD_SHA || "dev").slice(0, 7);
  if (!BUILD_TIME) return sha;
  const d = new Date(BUILD_TIME);
  if (Number.isNaN(d.getTime())) return sha;
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = d.getUTCDate();
  return `${sha} · ${month} ${day}`;
}

// Verbose "abc1234 · 2026-05-21 18:42 UTC" for the Settings About
// section, where the user is intentionally looking at version info
// and the extra detail is useful for support / cross-referencing
// commit history.
export function longBuildLabel() {
  const sha = (BUILD_SHA || "dev").slice(0, 7);
  if (!BUILD_TIME) return sha;
  const d = new Date(BUILD_TIME);
  if (Number.isNaN(d.getTime())) return sha;
  const date = d.toISOString().slice(0, 10);
  const time = d.toISOString().slice(11, 16);
  return `${sha} · ${date} ${time} UTC`;
}
