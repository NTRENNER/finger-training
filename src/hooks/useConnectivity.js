import { useCallback, useEffect, useState } from "react";

import { readPendingSyncCount } from "./usePendingSyncCount.js";

export const ONLINE_SYNC_DEBOUNCE_MS = 750;
// Returning to the app re-syncs at most this often. Every sync downloads the
// whole rep history, so syncing on each return cost about 1.8 MB a time.
// A return still syncs at once when something is waiting to upload or the
// device has been offline since the last sync.
export const FOREGROUND_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;

function readOnlineState() {
  if (typeof navigator === "undefined" || typeof navigator.onLine !== "boolean") {
    return true;
  }
  return navigator.onLine;
}

export function useConnectivity() {
  const [isOnline, setIsOnline] = useState(readOnlineState);
  const [syncSignal, setSyncSignal] = useState(0);

  const retrySync = useCallback(() => {
    setSyncSignal(value => value + 1);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    let retryTimer = null;
    // The app syncs when it starts, so the clock starts at mount.
    let lastSyncAt = Date.now();
    let offlineSinceSync = !readOnlineState();
    const handleOnline = () => {
      setIsOnline(true);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        lastSyncAt = Date.now();
        offlineSinceSync = false;
        retrySync();
      }, ONLINE_SYNC_DEBOUNCE_MS);
    };
    const handleOffline = () => {
      setIsOnline(false);
      offlineSinceSync = true;
      clearTimeout(retryTimer);
      retryTimer = null;
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible" || !readOnlineState()) return;
      const due = Date.now() - lastSyncAt >= FOREGROUND_SYNC_MIN_INTERVAL_MS;
      if (due || offlineSinceSync || readPendingSyncCount() > 0) handleOnline();
      else setIsOnline(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [retrySync]);

  return { isOnline, syncSignal, retrySync };
}
