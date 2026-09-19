/** Replace one screenshot path without ever leaving both versions in the rail. */
export function replaceRailPath(
  paths: readonly string[],
  previousPath: string,
  nextPath: string,
): string[] {
  const next: string[] = [];
  let inserted = false;

  for (const path of paths) {
    if (path === previousPath || path === nextPath) {
      if (!inserted) {
        next.push(nextPath);
        inserted = true;
      }
      continue;
    }
    next.push(path);
  }

  if (!inserted) next.unshift(nextPath);
  return next;
}

/** Hide paths while their local/cloud deletion is still in flight. */
export function omitPendingPaths(
  paths: readonly string[],
  pending: ReadonlySet<string>,
): string[] {
  if (pending.size === 0) return [...paths];
  return paths.filter((path) => !pending.has(path));
}
