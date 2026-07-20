// ─────────────────────────────────────────────────────────────
// useAuth — Supabase auth + 6-digit OTP login
// ─────────────────────────────────────────────────────────────
// Wraps Supabase's auth surface into a single hook that App.js
// can consume in one line. Owns:
//
//   * `user` — current signed-in user (or null), kept fresh by
//     subscribing to `onAuthStateChange`.
//   * `loginEmail` — text input bound to the email field on the
//     login screen.
//   * The OTP exchange state — `otpSent` (have we asked Supabase
//     to email a code), `otpCode` (text input bound to the
//     six-digit field), `otpBusy` (request in flight), `otpError`
//     (last error message from Supabase, displayed inline).
//
// Why OTP, not magic links: the magic-link flow opened in Gmail's
// in-app browser on Android, which never reached Chrome — so the
// session was created in a browser the user couldn't see. With an
// emailed code, the user types it back into our app and the
// session lands in the same browser they're using. Requires the
// Supabase "Magic Link" email template to include {{ .Token }}
// (Authentication → Email Templates in the Supabase dashboard).

import { useEffect, useState } from "react";

import { supabase } from "../lib/supabase.js";
import { readRawLastUser, setLastUserRaw, adoptAnonDataForUser } from "../lib/storage.js";

// Account-switch guard. Every ft_* localStorage cache is stored under
// a per-user namespace pinned at module load (see the USER NAMESPACING
// postmortem in lib/storage.js). This guard's only job is to notice
// when the signed-in user doesn't match the namespace this page was
// loaded with, record the new user, and request a reload so every
// hook re-seeds from the right namespace. Nothing is wiped anymore:
// the previous user's caches stay safe under their own prefix, and
// because setLastUserRaw never retargets the CURRENT page's writes,
// in-flight persistence effects keep landing in the old user's
// namespace until the reload — no window for cross-user bleed.
//
// Returns true when the caller must reload before letting the app run
// as this user; false when the page's namespace already matches.
export function guardUserSwitch(u) {
  const last = readRawLastUser();

  // Signing out is a namespace transition too. The current page is
  // pinned to the signed-in user's storage namespace and its mounted
  // hooks still hold that user's data in memory. Point the NEXT page at
  // the anonymous namespace and reload before rendering a signed-out
  // app. This also covers cross-tab sign-out and expired sessions.
  if (!u?.id) {
    if (last == null) return false;
    setLastUserRaw(null);
    return true;
  }

  // Same user re-authenticating (token refresh, re-login after an
  // offline stretch): the namespace already matches. Deliberately
  // does NOT re-save ft_last_user — the branch is fully idempotent,
  // which is also what terminates the post-reload cycle below.
  if (last === u.id) return false;

  // First sign-in this device has ever recorded (also the upgrade
  // path already handled by storage.js's module-load migration when
  // an OLD ft_last_user existed — here there was truly none). Adopt
  // the anonymous namespace's training data as this user's, then
  // reload: adoption MOVED the bare keys out from under hooks that
  // already mounted against the anonymous namespace, so they must
  // re-seed from the namespaced copies. No reload loop — post-reload,
  // last === u.id and the branch above returns false.
  if (last == null) {
    adoptAnonDataForUser(u.id);
    setLastUserRaw(u.id);
    return true;
  }

  // Different user than the namespace this page loaded with. Record
  // the new uid for the NEXT load and reload. NO WIPE: the old user's
  // caches live under their own `u:<uid>:` prefix, and the new user's
  // namespace is either empty or already contains their own data.
  setLastUserRaw(u.id);
  return true;
}

export function useAuth() {
  const [user,       setUser]       = useState(null);
  const [loginEmail, setLoginEmail] = useState("");

  // OTP exchange state. otpSent flips to true once Supabase has
  // accepted the email and is sending the code; once verifyOtp
  // succeeds it flips back to false (the auth subscription below
  // updates `user` on its own).
  const [otpSent,  setOtpSent]  = useState(false);
  const [otpCode,  setOtpCode]  = useState("");
  const [otpBusy,  setOtpBusy]  = useState(false);
  const [otpError, setOtpError] = useState(null);

  // Subscribe to auth state. getSession seeds the initial user;
  // onAuthStateChange keeps it in sync if the user signs in/out
  // in another tab or the JWT expires.
  useEffect(() => {
    // When the signed-in user doesn't match this page's storage
    // namespace, a reload is mandatory: hooks have already seeded
    // React state from the old namespace, and only a restart makes
    // them re-seed from the new one — same hammer pullFromCloud
    // already uses. Until the reload lands, their persistence effects
    // keep writing to the OLD namespace (storage.js pins nsUid at
    // module load), so nothing bleeds between accounts in the interim.
    const apply = (u) => {
      if (guardUserSwitch(u)) { window.location.reload(); return; }
      setUser(u);
    };
    supabase.auth.getSession().then(({ data }) => apply(data.session?.user ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => apply(s?.user ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  const sendOtp = async () => {
    if (!loginEmail || otpBusy) return;
    setOtpBusy(true);
    setOtpError(null);
    const { error } = await supabase.auth.signInWithOtp({
      email: loginEmail,
      options: { shouldCreateUser: true },
    });
    setOtpBusy(false);
    if (error) { setOtpError(error.message); return; }
    setOtpSent(true);
    setOtpCode("");
  };

  const verifyOtp = async () => {
    const token = (otpCode || "").replace(/\s+/g, "");
    if (!loginEmail || !token || otpBusy) return;
    setOtpBusy(true);
    setOtpError(null);
    const { error } = await supabase.auth.verifyOtp({
      email: loginEmail,
      token,
      type: "email",
    });
    setOtpBusy(false);
    if (error) { setOtpError(error.message); return; }
    // Success: onAuthStateChange will set `user` and trigger the history fetch.
    setOtpSent(false);
    setOtpCode("");
  };

  const cancelOtp = () => {
    setOtpSent(false);
    setOtpCode("");
    setOtpError(null);
  };

  const signOut = async () => { await supabase.auth.signOut(); };

  return {
    user,
    loginEmail, setLoginEmail,
    otpSent, otpCode, setOtpCode, otpBusy, otpError,
    sendOtp, verifyOtp, cancelOtp, signOut,
  };
}
