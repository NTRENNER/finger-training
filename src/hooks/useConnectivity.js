import { useCallback, useEffect, useState } from "react";

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

    const handleOnline = () => {
      setIsOnline(true);
      retrySync();
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [retrySync]);

  return { isOnline, syncSignal, retrySync };
}
