type RailIdentity = (path: string) => string;
const exactPath: RailIdentity = (path) => path;

/** Replace one screenshot path without ever leaving both versions in the rail. */
export function replaceRailPath(
  paths: readonly string[],
  previousPath: string,
  nextPath: string,
  identity: RailIdentity = exactPath,
): string[] {
  const previousId = identity(previousPath);
  const nextId = identity(nextPath);
  const next: string[] = [];
  let inserted = false;

  for (const path of paths) {
    if (identity(path) === previousId || identity(path) === nextId) {
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
  identity: RailIdentity = exactPath,
): string[] {
  if (pending.size === 0) return [...paths];
  const pendingIds = new Set([...pending].map(identity));
  return paths.filter((path) => !pendingIds.has(identity(path)));
}
