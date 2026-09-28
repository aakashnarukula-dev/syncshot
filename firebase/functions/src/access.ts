export type AccessState = { state: "licensed" } | { state: "trial"; expiresAt: number; daysLeft: number } | { state: "expired" };
export function accessState(lifetime: boolean, expiresAt: number, now: number): AccessState {
  if (lifetime) return { state: "licensed" };
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return { state: "expired" };
  return { state: "trial", expiresAt, daysLeft: Math.ceil((expiresAt - now) / 86_400_000) };
}
