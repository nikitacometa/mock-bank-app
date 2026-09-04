import { useEffect, useRef, useState } from 'react';

const easeOutQuint = (t: number) => 1 - (1 - t) ** 5;

/**
 * Animate a number towards `value` on CHANGE — never on first mount.
 * Entering a pause settles an active animation at its real target. Values that
 * arrive while already paused remain hidden until resume (docs/spec.md §5.3).
 * Honours prefers-reduced-motion.
 */
export function useCountUp(value: number, duration = 640, paused = false): number {
  const [display, setDisplay] = useState(value);
  const mounted = useRef(false);
  const raf = useRef(0);
  const current = useRef(value);
  const previouslyPaused = useRef(paused);
  const [settledPaused, setSettledPaused] = useState(paused);

  // A passive effect cannot settle `display` before memoized children receive
  // their first paused props. Derive that one render from the current target;
  // the effect then commits the same value before later paused updates freeze.
  const enteringPause = paused && !settledPaused;

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      current.current = value;
      previouslyPaused.current = paused;
      return;
    }
    cancelAnimationFrame(raf.current);
    const pauseChanged = paused !== previouslyPaused.current;
    const pauseStarted = paused && pauseChanged;
    previouslyPaused.current = paused;
    if (pauseChanged) setSettledPaused(paused);
    if (paused) {
      if (pauseStarted) {
        current.current = value;
        setDisplay(value);
      }
      return;
    }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const start = performance.now();
    const startValue = current.current;
    const tick = (now: number) => {
      const t = reduced ? 1 : Math.min(1, (now - start) / duration);
      const v = Math.round(startValue + (value - startValue) * easeOutQuint(t));
      current.current = v;
      setDisplay(v);
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value, duration, paused]);

  return enteringPause ? value : display;
}
