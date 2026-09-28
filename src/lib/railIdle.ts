/** A repeatable idle deadline: native hover/drag events can be lost on macOS. */
export function createRailIdleTimer(
  delay: number,
  shouldWait: () => Promise<boolean>,
  collapse: () => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  const stop = () => {
    generation++;
    clearTimeout(timer);
    timer = undefined;
  };
  const restart = () => {
    stop();
    const current = generation;
    timer = setTimeout(async () => {
      timer = undefined;
      let waiting = false;
      try { waiting = await shouldWait(); } catch { /* Lost native hover must not pin the rail. */ }
      if (generation !== current) return;
      if (waiting) restart();
      else collapse();
    }, delay);
  };
  return { restart, stop };
}
