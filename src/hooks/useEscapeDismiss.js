import { useEffect, useRef } from "react";

export function useEscapeDismiss(active, onDismiss) {
  const dismissRef = useRef(onDismiss);

  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!active) return undefined;
    const handleKeyDown = event => {
      if (event.key === "Escape") dismissRef.current?.();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active]);
}
