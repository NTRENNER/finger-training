import { useEffect } from "react";

// Keeps the screen on while `active`. A phone that locks mid-hold pauses
// the page and loses the force stream. The browser drops the lock whenever
// the page is hidden, so it is requested again on return. Unsupported or
// refused (e.g. battery saver) is silent.
export function useScreenWakeLock(active) {
  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !navigator.wakeLock?.request) return undefined;
    let lock = null;
    let pending = false;
    let disposed = false;
    const acquire = async () => {
      if (disposed || pending || document.visibilityState !== "visible" || (lock && !lock.released)) return;
      pending = true;
      try {
        const next = await navigator.wakeLock.request("screen");
        if (disposed) next.release().catch(() => {});
        else lock = next;
      } catch { /* refused; nothing to show */ }
      finally { pending = false; }
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", acquire);
      lock?.release().catch(() => {});
    };
  }, [active]);
}
