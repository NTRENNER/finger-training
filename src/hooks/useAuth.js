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
import { loadLS, saveLS, LS_LAST_USER_KEY, clearUserScopedLS } from "../lib/storage.js";

// Account-switch guard. None of the ft_* localStorage caches are
// namespaced by user, so if user B signs in on a device that still
// holds user A's caches, the reconcile loops would classify A's data
// as "local-only work" and push it into B's cloud account. Wipe the
// caches when the signed-in user differs from the last one; keep them
// when it's the same user (offline work must survive a re-login) or
// when there's no recorded previous user (first sign-in adopts the
// device's signed-out local history — that's the intended flow).
function guardUserSwitch(u) {
  if (!u?.id) return false;
  const last = loadLS(LS_LAST_USER_KEY);
  const switched = Boolean(last && last !== u.id);
  if (switched) {
    console.warn("useAuth: account switch detected — clearing local caches");
    clearUserScopedLS();
  }
  saveLS(LS_LAST_USER_KEY, u.id);
  return switched;
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
    // On an account switch, wiping localStorage isn't enough on its
    // own: hooks have already seeded React state from the previous
    // user's caches, and their persistence effects would write that
    // data right back (and the reconciles would push it into the new
    // user's cloud account). A full reload restarts every hook from
    // the now-empty caches — same hammer pullFromCloud already uses.
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
