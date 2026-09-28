/** Carbon can lose key-up while a system consent dialog takes focus. */
export function createShortcutGate(now = () => performance.now()) {
  const down = new Map<string, number>();
  return {
    accept(shortcut: string, state: "Pressed" | "Released") {
      if (state === "Released") {
        down.delete(shortcut);
        return false;
      }
      const time = now();
      const previous = down.get(shortcut);
      // Suppress key-repeat, but never poison this shortcut for the app lifetime.
      if (previous !== undefined && time - previous < 1500) return false;
      down.set(shortcut, time);
      return true;
    },
    clear() { down.clear(); },
  };
}
