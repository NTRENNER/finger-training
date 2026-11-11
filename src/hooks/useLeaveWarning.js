import { useEffect } from "react";

// While `active`, the browser asks before the page is reloaded or closed.
// A running session is held in memory, so a stray reload ends it: the
// finished reps are already saved, but the rest of the session would have
// to be started again as a new one.
export function useLeaveWarning(active) {
  useEffect(() => {
    if (!active || typeof window === "undefined") return undefined;
    const warn = event => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);
}
