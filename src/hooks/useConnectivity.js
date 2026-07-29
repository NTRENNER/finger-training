import { useCallback, useEffect, useState } from "react";

export const ONLINE_SYNC_DEBOUNCE_MS = 750;

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
    const handleOnline = () => {
      setIsOnline(true);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(retrySync, ONLINE_SYNC_DEBOUNCE_MS);
    };
    const handleOffline = () => {
      setIsOnline(false);
      clearTimeout(retryTimer);
      retryTimer = null;
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      clearTimeout(retryTimer);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [retrySync]);

  return { isOnline, syncSignal, retrySync };
}
