/**
 * ClipboardX sync — Firestore listener + writer.
 *
 * Mac capture: a Rust thread polls NSPasteboard.changeCount and emits
 * `clipboard-changed { text }`; the engine calls `writeClipboardEntry` which
 * dedupes against the most-recent hash and caps text at 100 KB before addDoc.
 * Re-copy: tap an entry -> `setLocalClipboard` -> Rust `set_clipboard_text`.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  Timestamp,
  type DocumentData,
} from "firebase/firestore";
import { db } from "./firebase";
import { sha256Text } from "./hash";
import {
  CLIPBOARD_LIMIT,
  CLIPBOARD_MAX_BYTES,
  type ClipboardDoc,
  type DeviceRef,
} from "./types";

function clipboardCol(libId: string) {
  return collection(db, "libraries", libId, "clipboard");
}

function tsToMillis(value: unknown): number | null {
  return value instanceof Timestamp ? value.toMillis() : null;
}

function mapDoc(id: string, data: DocumentData): ClipboardDoc {
  return {
    id,
    text: data.text ?? "",
    hash: data.hash ?? "",
    createdAt: tsToMillis(data.createdAt),
    device: (data.device ?? { uid: "", name: "", platform: "mac" }) as DeviceRef,
    pinned: data.pinned === true,
    charCount: data.charCount ?? (data.text ? String(data.text).length : 0),
  };
}

/**
 * Subscribe to the newest clipboard entries (createdAt desc, limit 200).
 * Returns an unsubscribe function.
 */
export function subscribeClipboard(
  libId: string,
  onChange: (items: ClipboardDoc[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const q = query(
    clipboardCol(libId),
    orderBy("createdAt", "desc"),
    limit(CLIPBOARD_LIMIT),
  );
  return onSnapshot(
    q,
    (snap) => onChange(snap.docs.map((d) => mapDoc(d.id, d.data()))),
    (err) => onError?.(err),
  );
}

/**
 * Write a captured clipboard string. Skips empty text, text larger than the
 * 100 KB cap, and consecutive duplicates (same hash as `recentHash`).
 * Returns the new hash on success, or null when skipped.
 */
export async function writeClipboardEntry(
  libId: string,
  device: DeviceRef,
  text: string,
  recentHash?: string | null,
): Promise<string | null> {
  if (!text) return null;
  // Byte length (UTF-8), not char length — the Firestore doc cap is on bytes.
  const byteLen = new TextEncoder().encode(text).length;
  if (byteLen > CLIPBOARD_MAX_BYTES) return null;

  const hash = await sha256Text(text);
  if (recentHash && hash === recentHash) return null;

  await addDoc(clipboardCol(libId), {
    text,
    hash,
    createdAt: serverTimestamp(),
    device,
    pinned: false,
    charCount: text.length,
  });
  return hash;
}

/** Write `text` to this Mac's system clipboard (re-copy a past entry). */
export async function setLocalClipboard(text: string): Promise<void> {
  await invoke("set_clipboard_text", { text });
}

/** Toggle the pinned flag on a clipboard entry. */
export async function setClipboardPinned(
  libId: string,
  id: string,
  pinned: boolean,
): Promise<void> {
  await updateDoc(doc(clipboardCol(libId), id), { pinned });
}

/** Delete a clipboard entry. */
export async function deleteClipboardEntry(
  libId: string,
  id: string,
): Promise<void> {
  await deleteDoc(doc(clipboardCol(libId), id));
}
