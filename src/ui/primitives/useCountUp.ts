import { useEffect, useRef, useState } from 'react';

const easeOutQuint = (t: number) => 1 - (1 - t) ** 5;

/**
 * Animate a number towards `value` on CHANGE — never on first mount
 * (docs/spec.md §5.3). Honours prefers-reduced-motion.
 */
export function useCountUp(value: number, duration = 640): number {
  const [display, setDisplay] = useState(value);
  const mounted = useRef(false);
  const raf = useRef(0);
  const from = useRef(value);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      from.current = value;
      return;
    }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const start = performance.now();
    const startValue = from.current;
    const tick = (now: number) => {
      const t = reduced ? 1 : Math.min(1, (now - start) / duration);
      const v = Math.round(startValue + (value - startValue) * easeOutQuint(t));
      setDisplay(v);
      if (t < 1) raf.current = requestAnimationFrame(tick);
      else from.current = value;
    };
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value, duration]);

  return display;
}
