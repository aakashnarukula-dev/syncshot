import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";

export interface EditorSaveSession { path: string }

/** Preserve edit order without holding the visible replacement behind clipboard
 * conversion. Each session owns its path, even when a new image opens mid-save. */
export function createEditorPersistence() {
  let writes: Promise<unknown> = Promise.resolve();
  let copies: Promise<unknown> = Promise.resolve();

  return (session: EditorSaveSession, canvas: HTMLCanvasElement, previewDataUrl: string): Promise<string> => {
    const saved = writes.catch(() => {}).then(async () => {
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Failed to encode image")), "image/png");
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const saveDir = await invoke<string>("get_temp_directory");
      if (!saveDir) throw new Error("Save directory not set");
      const newPath = await invoke<string>("save_edited_image_bytes", bytes, {
        headers: { "save-dir": encodeURIComponent(saveDir) },
      });
      const originalPath = session.path;
      session.path = newPath;
      // Copy from retained bytes: cloud publication may delete the staging file
      // before this clipboard job runs. Older copies always finish first.
      const copied = copies.catch(() => {}).then(() => invoke("copy_png_bytes_to_clipboard", bytes));
      copies = copied;
      void copied.catch(() => {});
      await emit("editor-saved", { originalPath, newPath, previewDataUrl });
      return { newPath, copied };
    });
    writes = saved;
    return saved.then(async ({ newPath, copied }) => {
      await copied;
      return newPath;
    });
  };
}
