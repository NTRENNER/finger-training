import { useEffect, useRef } from "react";

// Close an inline popup when the user taps or clicks anywhere outside it.
// `ignoreSelector` exempts elements that manage the popup themselves (for
// example chart points that open, switch, or toggle it on click).
export function useOutsideDismiss(active, ref, onDismiss, ignoreSelector) {
  const dismissRef = useRef(onDismiss);

  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!active) return undefined;
    const handlePointerDown = event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (ref.current?.contains(target)) return;
      if (ignoreSelector && target.closest(ignoreSelector)) return;
      dismissRef.current?.();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [active, ref, ignoreSelector]);
}
