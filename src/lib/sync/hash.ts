/** SHA-256 hashing helpers (Web Crypto) for content-addressed dedup. */

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/** SHA-256 hex digest of raw bytes (used to dedup screenshots). */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
}

/** SHA-256 hex digest of a UTF-8 string (used to dedup clipboard text). */
export async function sha256Text(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
}
