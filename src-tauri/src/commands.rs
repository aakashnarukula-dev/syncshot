//! Tauri commands module

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

use crate::clipboard::{copy_image_bytes_to_clipboard, copy_image_to_clipboard};
use crate::image::{
    copy_screenshot_to_dir, crop_image, save_base64_image, save_base64_image_to_path, CropRegion,
};
use crate::screenshot::{
    capture_all_monitors as capture_monitors, capture_primary_monitor, MonitorShot,
};
use crate::utils::{generate_filename, get_desktop_path, get_syncshot_dir_path};
use std::fs;

static SCREENCAPTURE_LOCK: Mutex<()> = Mutex::new(());

/// Newest-first index for the rail's cache directory. The rail polls for new
/// captures, but most polls see an unchanged directory; re-statting thousands
/// of old files on every one of those polls was needless blocking I/O.
struct ScreenshotDirIndex {
    modified: std::time::SystemTime,
    files: Vec<IndexedScreenshotPath>,
}

#[derive(Clone)]
struct IndexedScreenshotPath {
    path: PathBuf,
    modified: std::time::SystemTime,
}

// Keep a separate index per source. The rail can safely combine the private
// SyncShot cache with a user's pre-existing Desktop library without rescanning
// thousands of files every polling interval.
static SCREENSHOT_DIR_INDEX: OnceLock<Mutex<HashMap<PathBuf, ScreenshotDirIndex>>> =
    OnceLock::new();

fn screenshot_index_cache() -> &'static Mutex<HashMap<PathBuf, ScreenshotDirIndex>> {
    SCREENSHOT_DIR_INDEX.get_or_init(|| Mutex::new(HashMap::new()))
}

fn directory_modified(path: &std::path::Path) -> Result<std::time::SystemTime, String> {
    fs::metadata(path)
        .map_err(|e| format!("Failed to stat dir: {e}"))?
        .modified()
        .map_err(|e| format!("Failed to read dir modification time: {e}"))
}

fn is_screenshot_extension(ext: &str) -> bool {
    matches!(
        ext,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "heic" | "heif"
    )
}

fn scan_screenshot_paths(path: &std::path::Path) -> Result<Vec<IndexedScreenshotPath>, String> {
    let entries = fs::read_dir(path).map_err(|e| format!("Failed to read dir: {e}"))?;
    let mut files: Vec<IndexedScreenshotPath> = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        if !is_screenshot_extension(&ext) {
            continue;
        }
        // One metadata() call answers both is_file and mtime (the old
        // p.is_file() was a second redundant stat per entry).
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        files.push(IndexedScreenshotPath {
            path: p,
            modified: meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH),
        });
    }
    files.sort_by_key(|entry| std::cmp::Reverse(entry.modified));
    Ok(files)
}

fn indexed_screenshot_paths(path: &std::path::Path) -> Result<Vec<IndexedScreenshotPath>, String> {
    let modified = directory_modified(path)?;
    if let Ok(cache) = screenshot_index_cache().lock() {
        if let Some(index) = cache.get(path) {
            if index.modified == modified {
                return Ok(index.files.clone());
            }
        }
    }

    let files = scan_screenshot_paths(path)?;
    // Read the timestamp after the scan so an add/delete during the scan makes
    // the next poll rebuild rather than trusting a half-old index.
    let indexed_modified = directory_modified(path)?;
    if let Ok(mut cache) = screenshot_index_cache().lock() {
        cache.insert(
            path.to_path_buf(),
            ScreenshotDirIndex {
                modified: indexed_modified,
                files: files.clone(),
            },
        );
    }
    Ok(files)
}

/// Merge a small set of metadata-only indexes. Image bytes remain lazy: the
/// webview requests them only for the virtualized tiles in its viewport.
fn indexed_screenshot_paths_from_dirs(dirs: Vec<String>) -> Result<Vec<PathBuf>, String> {
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for dir in dirs {
        let path = PathBuf::from(dir);
        if !path.exists() || !seen.insert(path.clone()) {
            continue;
        }
        files.extend(indexed_screenshot_paths(&path)?);
    }
    files.sort_by_key(|entry| std::cmp::Reverse(entry.modified));
    Ok(files.into_iter().map(|entry| entry.path).collect())
}

/// Resolve local display sources without relying on frontend startup state.
/// The active capture root and Desktop are both display sources; duplicate
/// paths are removed by the merged index. Desktop files remain read-only in
/// the frontend and are never used for capture backfill.
fn screenshot_source_dirs(primary_dir: String) -> Result<Vec<String>, String> {
    Ok(vec![primary_dir, get_desktop_path()?])
}

/// Quick capture of primary monitor
#[tauri::command]
pub async fn capture_once(
    app_handle: AppHandle,
    save_dir: String,
    copy_to_clip: bool,
) -> Result<String, String> {
    let screenshot_path = capture_primary_monitor(app_handle).await?;
    let screenshot_path_str = screenshot_path.to_string_lossy().to_string();

    // Multi-MB file copy + (optionally) a full read + pasteboard write —
    // blocking work, off the async runtime.
    tauri::async_runtime::spawn_blocking(move || {
        let saved_path = copy_screenshot_to_dir(&screenshot_path_str, &save_dir)?;
        if copy_to_clip {
            copy_image_to_clipboard(&saved_path)?;
        }
        Ok(saved_path)
    })
    .await
    .map_err(|e| format!("Capture task failed: {}", e))?
}

/// Capture all monitors with geometry info
#[tauri::command]
pub async fn capture_all_monitors(
    _app_handle: AppHandle,
    save_dir: String,
) -> Result<Vec<MonitorShot>, String> {
    // xcap capture + PNG encode per monitor: seconds of CPU on retina displays.
    tauri::async_runtime::spawn_blocking(move || capture_monitors(&save_dir))
        .await
        .map_err(|e| format!("Capture task failed: {}", e))?
}

/// Crop a region from a screenshot
#[tauri::command]
pub async fn capture_region(
    screenshot_path: String,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    save_dir: String,
) -> Result<String, String> {
    let region = CropRegion {
        x,
        y,
        width,
        height,
    };
    // Full-res decode + crop + encode: 1–3s on a retina screenshot.
    tauri::async_runtime::spawn_blocking(move || crop_image(&screenshot_path, region, &save_dir))
        .await
        .map_err(|e| format!("Crop task failed: {}", e))?
}

/// Save a native screenshot file to the user's save dir and optionally copy to clipboard
#[tauri::command]
pub async fn save_native_screenshot(
    app: AppHandle,
    source_path: String,
    save_dir: String,
    copy_to_clip: bool,
) -> Result<String, String> {
    let saved_path = tauri::async_runtime::spawn_blocking(move || {
        let saved_path = copy_screenshot_to_dir(&source_path, &save_dir)?;
        if copy_to_clip {
            copy_image_to_clipboard(&saved_path)?;
        }
        Ok::<String, String>(saved_path)
    })
    .await
    .map_err(|e| format!("Save task failed: {}", e))??;
    // Notify the webview so the Firebase sync engine can upload this capture.
    // (The publisher dedupes by sha256, so a spurious emit is harmless.)
    use tauri::Emitter;
    let _ = app.emit("new-screenshot", saved_path.clone());
    Ok(saved_path)
}

/// Rename a locally-captured screenshot cache file so it carries its Firestore
/// doc id (`{docId}.<ext>`, SAME directory, extension preserved). Captures land
/// as `shot_{ts}.png` (no embedded id); once published we adopt the doc-id name
/// so the pill column's local file resolves its cloud doc straight from the
/// filename (`cacheDocId`) — copy-link, the render fallback and tap-open all
/// work. We RENAME (not copy) so there is exactly ONE cache file: a second
/// `{docId}.png` alongside `shot_{ts}.png` would double the tile, since the
/// column polls the cache dir. Idempotent: a file already named `{docId}.<ext>`
/// is returned unchanged. Returns the new absolute path.
#[tauri::command]
pub async fn rename_screenshot_to_doc_id(path: String, doc_id: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err(format!("Screenshot file not found: {}", path));
    }
    // Defensive: a Firestore auto id is already [A-Za-z0-9], but strip anything
    // else so the doc id can never escape the cache dir via the filename.
    let stem: String = doc_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if stem.is_empty() {
        return Err("Invalid doc id for cache filename".to_string());
    }
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .filter(|e| !e.is_empty())
        .unwrap_or("png")
        .to_string();
    let dir = src
        .parent()
        .ok_or_else(|| "Screenshot path has no parent directory".to_string())?;
    let dest = dir.join(format!("{}.{}", stem, ext));
    if dest == src {
        return Ok(path);
    }
    fs::rename(&src, &dest).map_err(|e| format!("Failed to rename screenshot: {}", e))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Sanitize a supplied name into a safe filename for the local cache; fall back
/// to a generated one if it sanitizes to empty. Pure (no I/O) so it can be unit
/// tested without touching the filesystem or clipboard.
fn safe_synced_filename(name: &str) -> Result<String, String> {
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.is_empty() {
        generate_filename("synced", "png")
    } else {
        Ok(safe)
    }
}

/// Pick the cache filename for a synced image: sanitize the requested name, then
/// force its extension to match the image type SNIFFED from the actual bytes.
/// The receive path passes `{docId}.png` for everything, but a phone's bytes are
/// often JPEG/WEBP/HEIC — saving under the true extension is what gives the file
/// a real Finder/QuickLook preview. Falls back to the sanitized name when the
/// format isn't recognized.
fn synced_filename_for(name: &str, bytes: &[u8]) -> Result<String, String> {
    let safe = safe_synced_filename(name)?;
    match crate::image::detect_image_kind(bytes) {
        Some(kind) => {
            let mut p = PathBuf::from(&safe);
            p.set_extension(kind.extension());
            Ok(p.to_string_lossy().into_owned())
        }
        None => Ok(safe),
    }
}

fn numbered_filename(name: &str, index: usize) -> String {
    if index == 0 {
        return name.to_string();
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("SyncShot");
    match path.extension().and_then(|value| value.to_str()) {
        Some(extension) if !extension.is_empty() => format!("{stem} ({index}).{extension}"),
        _ => format!("{stem} ({index})"),
    }
}

/// Write a downloaded image without replacing an existing user file. Using
/// create_new closes the race between checking a filename and creating it.
fn write_image_to_directory(
    directory: &Path,
    requested_name: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    fs::create_dir_all(directory)
        .map_err(|e| format!("Failed to create download directory: {e}"))?;
    let safe_name = synced_filename_for(requested_name, bytes)?;
    for index in 0..10_000 {
        let path = directory.join(numbered_filename(&safe_name, index));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                if let Err(error) = file.write_all(bytes) {
                    drop(file);
                    let _ = fs::remove_file(&path);
                    return Err(format!("Failed to write downloaded image: {error}"));
                }
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Failed to create downloaded image: {error}")),
        }
    }
    Err("Too many files with the same name in Downloads".to_string())
}

const MAX_SYNCED_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
// One Firestore page contains 16 screenshots. Buffer that page in RAM when it
// fits, but keep a hard byte ceiling so a library of thousands of screenshots
// can never exhaust the machine. Nothing in this cache is written to disk.
const MAX_REMOTE_IMAGE_CACHE_BYTES: usize = 256 * 1024 * 1024;
const MAX_REMOTE_IMAGE_CACHE_ENTRIES: usize = 16;

/// Full-resolution cloud images are never persisted on Mac. Keep only a tiny
/// process-memory LRU so opening and copying the same screenshot share the
/// bytes instead of issuing two Firebase downloads. The cache disappears when
/// SyncShot exits and versioned URLs ensure an edit never reuses stale bytes.
#[derive(Default)]
struct RemoteImageMemoryCache {
    entries: VecDeque<(String, Vec<u8>)>,
    bytes: usize,
}

static REMOTE_IMAGE_MEMORY_CACHE: OnceLock<Mutex<RemoteImageMemoryCache>> = OnceLock::new();

fn remote_image_memory_cache() -> &'static Mutex<RemoteImageMemoryCache> {
    REMOTE_IMAGE_MEMORY_CACHE.get_or_init(|| Mutex::new(RemoteImageMemoryCache::default()))
}

fn cached_remote_image(url: &str) -> Option<Vec<u8>> {
    let mut cache = remote_image_memory_cache().lock().ok()?;
    let index = cache.entries.iter().position(|(key, _)| key == url)?;
    let entry = cache.entries.remove(index)?;
    let bytes = entry.1.clone();
    cache.entries.push_back(entry);
    Some(bytes)
}

fn cache_remote_image(url: &str, bytes: &[u8]) {
    if bytes.len() > MAX_REMOTE_IMAGE_CACHE_BYTES {
        return;
    }
    let Ok(mut cache) = remote_image_memory_cache().lock() else {
        return;
    };
    if let Some(index) = cache.entries.iter().position(|(key, _)| key == url) {
        if let Some((_, old)) = cache.entries.remove(index) {
            cache.bytes = cache.bytes.saturating_sub(old.len());
        }
    }
    cache.entries.push_back((url.to_owned(), bytes.to_vec()));
    cache.bytes += bytes.len();
    while cache.entries.len() > MAX_REMOTE_IMAGE_CACHE_ENTRIES
        || cache.bytes > MAX_REMOTE_IMAGE_CACHE_BYTES
    {
        if let Some((_, old)) = cache.entries.pop_front() {
            cache.bytes = cache.bytes.saturating_sub(old.len());
        } else {
            break;
        }
    }
}

fn synced_image_http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(3))
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .expect("valid SyncShot HTTP client")
    })
}

/// Remove cloud copies materialized for a native drag by a previous process.
/// Current captures/editor exports use different names and are never touched.
pub fn cleanup_temporary_cloud_materializations() {
    let Ok(entries) = fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_ours = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("syncshot-cloud-"));
        if is_ours && path.is_file() {
            let _ = fs::remove_file(path);
        }
    }
}

fn validate_synced_image_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("Invalid image URL: {e}"))?;
    let host = parsed.host_str().unwrap_or_default();
    if parsed.scheme() != "https"
        || !matches!(
            host,
            "firebasestorage.googleapis.com" | "storage.googleapis.com"
        )
    {
        return Err("Only Firebase Storage HTTPS image URLs are allowed".to_string());
    }
    Ok(())
}

async fn fetch_synced_image_bytes(url: &str) -> Result<Vec<u8>, String> {
    validate_synced_image_url(url)?;
    if let Some(bytes) = cached_remote_image(url) {
        return Ok(bytes);
    }
    let resp = synced_image_http_client()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch synced image: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Failed to fetch synced image: HTTP {}",
            resp.status()
        ));
    }
    if resp.content_length().unwrap_or(0) > MAX_SYNCED_IMAGE_BYTES {
        return Err("Synced image exceeds the 64 MB safety limit".to_string());
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read synced image body: {e}"))?;
    if bytes.len() as u64 > MAX_SYNCED_IMAGE_BYTES {
        return Err("Synced image exceeds the 64 MB safety limit".to_string());
    }
    let bytes = bytes.to_vec();
    cache_remote_image(url, &bytes);
    Ok(bytes)
}

/// Warm full-resolution Firebase images into the bounded process-memory LRU.
/// The frontend sends only the currently loaded Firestore page(s), never the
/// user's entire library. Three concurrent downloads keep the network busy
/// without starving visible thumbnails or creating a 3,000-request burst.
#[tauri::command]
pub async fn prefetch_remote_images(urls: Vec<String>) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let urls: Vec<String> = urls
        .into_iter()
        .filter(|url| seen.insert(url.clone()))
        .take(64)
        .collect();
    let mut warmed = Vec::new();

    for chunk in urls.chunks(3) {
        let tasks: Vec<_> = chunk
            .iter()
            .cloned()
            .map(|url| {
                tauri::async_runtime::spawn(async move {
                    fetch_synced_image_bytes(&url).await.map(|_| url)
                })
            })
            .collect();
        for task in tasks {
            if let Ok(Ok(url)) = task.await {
                warmed.push(url);
            }
        }
    }

    Ok(warmed)
}

/// Drop all preloaded cloud bytes (sign-out/app teardown). The cache is RAM
/// only, but clearing it at the account boundary prevents cross-user reuse.
#[tauri::command]
pub fn clear_remote_image_cache() {
    if let Ok(mut cache) = remote_image_memory_cache().lock() {
        cache.entries.clear();
        cache.bytes = 0;
    }
}

/// Copy a Firebase screenshot straight from memory to NSPasteboard. No cache
/// file is created, so cross-device auto-copy stays cloud-only.
#[tauri::command]
pub async fn copy_remote_image_to_clipboard(url: String) -> Result<(), String> {
    let bytes = fetch_synced_image_bytes(&url).await?;
    tauri::async_runtime::spawn_blocking(move || copy_image_bytes_to_clipboard(&bytes))
        .await
        .map_err(|e| format!("Clipboard task failed: {e}"))?
}

/// Materialize a cloud image only for a native operation that requires a file
/// path (currently OS drag). The caller deletes this short-lived temp file.
#[tauri::command]
pub async fn download_temporary_image(url: String, name: String) -> Result<String, String> {
    let bytes = fetch_synced_image_bytes(&url).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let safe = synced_filename_for(&name, &bytes)?;
        let unique = crate::utils::get_timestamp()?;
        let path = std::env::temp_dir().join(format!("syncshot-cloud-{unique}-{safe}"));
        fs::write(&path, bytes).map_err(|e| format!("Failed to write temp image: {e}"))?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("Temp image task failed: {e}"))?
}

/// Save a full-resolution screenshot to the user's Downloads directory. Cloud
/// images reuse the bounded RAM cache warmed by the rail; local staging images
/// are read directly. Exactly one source must be supplied.
#[tauri::command]
pub async fn save_image_to_downloads(
    path: Option<String>,
    url: Option<String>,
    name: String,
) -> Result<String, String> {
    let bytes = match (path, url) {
        (None, Some(url)) => fetch_synced_image_bytes(&url).await?,
        (Some(path), None) => tauri::async_runtime::spawn_blocking(move || {
            fs::read(&path).map_err(|e| format!("Failed to read {path}: {e}"))
        })
        .await
        .map_err(|e| format!("Download read task failed: {e}"))??,
        _ => return Err("Exactly one image source is required".to_string()),
    };
    let downloads =
        dirs::download_dir().ok_or_else(|| "Downloads directory is unavailable".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        write_image_to_directory(&downloads, &name, &bytes)
            .map(|saved| saved.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("Download write task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_stat_serializes_camel_case() {
        // The frontend backfill ledger expects EXACTLY { "mtimeMs", "size" }.
        let stat = FileStat {
            mtime_ms: 1234,
            size: 42,
        };
        let json = serde_json::to_value(&stat).unwrap();
        assert_eq!(json, serde_json::json!({ "mtimeMs": 1234, "size": 42 }));
    }

    #[test]
    fn safe_synced_filename_keeps_valid_names() {
        assert_eq!(safe_synced_filename("abc123.png").unwrap(), "abc123.png");
        assert_eq!(
            safe_synced_filename("doc-id_42.png").unwrap(),
            "doc-id_42.png"
        );
    }

    #[test]
    fn safe_synced_filename_sanitizes_path_and_space_chars() {
        // A Firestore doc id is alphanumeric, but defend against anything that
        // could escape the cache dir or break the write. Dots are allowed, but
        // every path separator becomes '_' so the result can't escape the dir.
        assert_eq!(
            safe_synced_filename("../etc/passwd").unwrap(),
            ".._etc_passwd"
        );
        assert!(!safe_synced_filename("../etc/passwd").unwrap().contains('/'));
        assert_eq!(safe_synced_filename("a b/c.png").unwrap(), "a_b_c.png");
    }

    #[test]
    fn safe_synced_filename_falls_back_when_empty() {
        // Only a truly empty name triggers the generated fallback.
        let generated = safe_synced_filename("").unwrap();
        assert!(generated.starts_with("synced_"), "got: {generated}");
        assert!(generated.ends_with(".png"), "got: {generated}");
    }

    #[test]
    fn synced_filename_uses_real_type_over_requested_extension() {
        // Receive path always asks for `{docId}.png`; JPEG bytes must override
        // the extension so the saved file gets a Finder preview.
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0];
        assert_eq!(
            synced_filename_for("doc123.png", &jpeg).unwrap(),
            "doc123.jpg"
        );

        let png = b"\x89PNG\r\n\x1a\n";
        assert_eq!(
            synced_filename_for("doc123.png", png).unwrap(),
            "doc123.png"
        );

        let webp = b"RIFF\x24\x00\x00\x00WEBPVP8 ";
        assert_eq!(
            synced_filename_for("doc123.png", webp).unwrap(),
            "doc123.webp"
        );
    }

    #[test]
    fn synced_filename_keeps_name_when_type_unknown() {
        // Unrecognized bytes leave the (sanitized) requested name untouched.
        assert_eq!(
            synced_filename_for("doc123.png", b"not an image").unwrap(),
            "doc123.png"
        );
    }

    #[test]
    fn download_write_preserves_existing_file_and_real_type() {
        let dir = std::env::temp_dir().join(format!(
            "syncshot-download-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let png = b"\x89PNG\r\n\x1a\n";

        let first = write_image_to_directory(&dir, "shot.jpg", png).unwrap();
        let second = write_image_to_directory(&dir, "shot.jpg", png).unwrap();

        assert_eq!(first.file_name().unwrap(), "shot.png");
        assert_eq!(second.file_name().unwrap(), "shot (1).png");
        assert_eq!(fs::read(first).unwrap(), png);
        assert_eq!(fs::read(second).unwrap(), png);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn scan_screenshot_paths_orders_real_extensions_newest_first() {
        let dir = std::env::temp_dir().join(format!(
            "syncshot-list-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("older.jpg"), b"jpg").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(dir.join("newer.heic"), b"heic").unwrap();
        fs::write(dir.join("ignore.txt"), b"text").unwrap();

        let names: Vec<String> = scan_screenshot_paths(&dir)
            .unwrap()
            .into_iter()
            .map(|entry| {
                entry
                    .path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();

        assert_eq!(names, vec!["newer.heic", "older.jpg"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn merged_sources_page_newest_files_before_older_ones() {
        let root = std::env::temp_dir().join(format!(
            "syncshot-multi-source-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let cache = root.join("cache");
        let desktop = root.join("desktop");
        fs::create_dir_all(&cache).unwrap();
        fs::create_dir_all(&desktop).unwrap();
        fs::write(cache.join("older.png"), b"png").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(desktop.join("newer.jpg"), b"jpg").unwrap();

        let names: Vec<String> = indexed_screenshot_paths_from_dirs(vec![
            cache.to_string_lossy().into_owned(),
            desktop.to_string_lossy().into_owned(),
        ])
        .unwrap()
        .into_iter()
        .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
        .collect();

        assert_eq!(names, vec!["newer.jpg", "older.png"]);
        fs::remove_dir_all(root).unwrap();
    }
}

/// Write text to the system clipboard (re-copy a synced ClipboardX entry).
#[tauri::command]
pub async fn set_clipboard_text(text: String) -> Result<(), String> {
    crate::clipboard::set_clipboard_string(&text)
}

/// Copy an existing image file to the system clipboard.
/// Used when a screenshot arrives via folder sync from another Mac.
#[tauri::command]
pub async fn copy_to_clipboard(path: String) -> Result<(), String> {
    // Multi-MB fs::read + NSPasteboard write; auto-fires on every fresh
    // arrival, so it must never run inline on a runtime worker. NSPasteboard
    // off-main matches the existing clipboard watcher thread.
    tauri::async_runtime::spawn_blocking(move || copy_image_to_clipboard(&path))
        .await
        .map_err(|e| format!("Clipboard task failed: {}", e))?
}

/// Delete a file (used to remove the temp capture once saved)
#[tauri::command]
pub async fn delete_file(path: String) -> Result<(), String> {
    if std::path::Path::new(&path).exists() {
        crate::image::delete_thumbnail_cache_for_source(&path);
        fs::remove_file(&path).map_err(|e| format!("Failed to delete file: {}", e))?;
    }
    Ok(())
}

/// The editor is a pre-warmed SINGLETON window: built once (hidden at app
/// startup, or on first open), then reused — open = show + deliver the new
/// image path, close = the frontend hides instead of destroying. The label
/// must keep the "editor-" prefix because capability files scope IPC to
/// "editor-*".
pub const EDITOR_WINDOW_LABEL: &str = "editor-main";

/// Image path waiting for the editor webview. Events emitted while the
/// webview is still booting are silently dropped, so opens park the path
/// here and the editor pulls it on mount AND on every "editor-open" ping
/// (take semantics — each request is consumed exactly once).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorPendingSource {
    image_path: String,
    image_url: Option<String>,
    preview_url: Option<String>,
}

static EDITOR_PENDING_PATH: Mutex<Option<EditorPendingSource>> = Mutex::new(None);

#[tauri::command]
pub fn take_editor_pending_path() -> Option<EditorPendingSource> {
    EDITOR_PENDING_PATH.lock().ok().and_then(|mut g| g.take())
}

/// Build the singleton editor webview. The URL carries a sentinel instead of
/// a real path — the image is always delivered through the pending-path slot
/// so first open and reuse share one code path.
pub fn build_editor_window(
    app: &tauri::AppHandle,
    visible: bool,
) -> Result<tauri::WebviewWindow, String> {
    use tauri::{TitleBarStyle, WebviewUrl, WebviewWindowBuilder};
    WebviewWindowBuilder::new(
        app,
        EDITOR_WINDOW_LABEL,
        WebviewUrl::App("?editor=__pending__".into()),
    )
    .inner_size(900.0, 700.0)
    .decorations(true)
    .title_bar_style(TitleBarStyle::Overlay)
    .hidden_title(true)
    .title("")
    .resizable(true)
    .center()
    .visible(visible)
    .focused(visible)
    .accept_first_mouse(true)
    .build()
    .map_err(|e| format!("Failed to open editor window: {}", e))
}

/// Open the editor for the given screenshot path. The singleton remains hidden
/// while its webview decodes the full image, sizes itself to the final aspect
/// ratio, and renders the first canvas frame. The frontend reveals it only
/// after that handshake, preventing black/blurred/wrong-size flashes.
#[tauri::command]
pub async fn open_editor_window(
    app: tauri::AppHandle,
    label: String,
    image_path: String,
    image_url: Option<String>,
    preview_url: Option<String>,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    let _ = label; // singleton now; parameter kept for IPC compatibility
    if !image_path.is_empty() {
        if let Ok(mut pending) = EDITOR_PENDING_PATH.lock() {
            *pending = Some(EditorPendingSource {
                image_path,
                image_url: image_url.filter(|url| !url.is_empty()),
                preview_url: preview_url.filter(|url| !url.is_empty()),
            });
        }
    }
    if let Some(win) = app.get_webview_window(EDITOR_WINDOW_LABEL) {
        let _ = win.unminimize();
        let _ = win.hide();
        // Ping only — the webview pulls the path via take_editor_pending_path,
        // which also covers pings that land while it is still booting.
        let _ = app.emit("editor-open", ());
        return Ok(());
    }
    build_editor_window(&app, false)?;
    Ok(())
}

/// Save an edited image from base64 data
#[tauri::command]
pub async fn save_edited_image(
    image_data: String,
    save_dir: String,
    copy_to_clip: bool,
    overwrite_path: Option<String>,
) -> Result<String, String> {
    // Base64 decode of a multi-MB export + file write + pasteboard: blocking.
    tauri::async_runtime::spawn_blocking(move || {
        let saved_path = match overwrite_path {
            Some(ref p) if !p.is_empty() => save_base64_image_to_path(&image_data, p)?,
            _ => save_base64_image(&image_data, &save_dir, "syncshot")?,
        };

        if copy_to_clip {
            copy_image_to_clipboard(&saved_path)?;
        }

        Ok(saved_path)
    })
    .await
    .map_err(|e| format!("Save task failed: {}", e))?
}

/// Save an edited image from RAW PNG bytes (the `tauri::ipc::Request` body).
/// Faster sibling of `save_edited_image`: skips the base64 data-URL round-trip
/// (~33% larger payload plus a multi-MB JSON string parse) — the webview ships
/// the ArrayBuffer straight through the IPC raw-body path. Invoke with the
/// bytes as the request body and the options as headers:
///
///   invoke('save_edited_image_bytes', new Uint8Array(bytes), { headers: {
///     'save-dir': encodeURIComponent(saveDir),     // required unless overwrite-path set
///     'copy-to-clip': '1',                         // optional: '1' or 'true'
///     'overwrite-path': encodeURIComponent(path),  // optional: exact path to overwrite
///   }})
///
/// Header values are percent-encoded so non-ASCII paths survive HTTP header
/// transport. `save_edited_image` (data-URL string) keeps working unchanged.
#[tauri::command]
pub async fn save_edited_image_bytes(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let bytes: Vec<u8> = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        _ => return Err("save_edited_image_bytes expects a raw byte body".to_string()),
    };
    let header = |name: &str| -> Result<Option<String>, String> {
        match request.headers().get(name) {
            None => Ok(None),
            Some(v) => {
                let s = v
                    .to_str()
                    .map_err(|e| format!("invalid {} header: {}", name, e))?;
                let decoded = urlencoding::decode(s)
                    .map_err(|e| format!("invalid {} header: {}", name, e))?;
                Ok(Some(decoded.into_owned()))
            }
        }
    };
    let save_dir = header("save-dir")?;
    let overwrite_path = header("overwrite-path")?.filter(|p| !p.is_empty());
    let copy_to_clip = matches!(header("copy-to-clip")?.as_deref(), Some("1") | Some("true"));

    tauri::async_runtime::spawn_blocking(move || {
        let saved_path = match overwrite_path {
            Some(ref p) => crate::image::save_image_bytes_to_path(&bytes, p)?,
            None => {
                let dir =
                    save_dir.ok_or("save-dir header required when overwrite-path is not set")?;
                crate::image::save_image_bytes(&bytes, &dir, "syncshot")?
            }
        };
        if copy_to_clip {
            copy_image_to_clipboard(&saved_path)?;
        }
        Ok(saved_path)
    })
    .await
    .map_err(|e| format!("Save task failed: {}", e))?
}

/// Return the legacy app-data screenshot path without creating it. Command name
/// is kept for migration/settings IPC compatibility.
#[tauri::command]
pub async fn get_desktop_directory() -> Result<String, String> {
    Ok(get_syncshot_dir_path())
}

/// Remove the legacy screenshot directory after its images have migrated.
/// Refuses to remove a non-empty directory (apart from Finder's `.DS_Store`),
/// so an upload failure can never erase the only remaining copy.
#[tauri::command]
pub async fn remove_legacy_screenshot_directory() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = PathBuf::from(get_syncshot_dir_path());
        if !dir.exists() {
            return Ok(());
        }
        let finder_metadata = dir.join(".DS_Store");
        if finder_metadata.is_file() {
            fs::remove_file(&finder_metadata)
                .map_err(|e| format!("Failed to remove legacy Finder metadata: {e}"))?;
        }
        fs::remove_dir(&dir)
            .map_err(|e| format!("Legacy screenshot directory is not empty; preserving it: {e}"))
    })
    .await
    .map_err(|e| format!("Legacy cache cleanup task failed: {e}"))?
}

/// Get the raw user Desktop path (no subfolder). Used to detect legacy save dirs.
#[tauri::command]
pub async fn get_desktop_root() -> Result<String, String> {
    get_desktop_path()
}

/// List a newest-first page of screenshot files in a directory.
///
/// The frontend requests a small initial page for the edge rail, then asks for
/// older pages while the user scrolls. Keeping the IPC response bounded prevents
/// a large local cache from being copied into the webview on every poll.
#[tauri::command]
pub async fn list_screenshots(
    dir: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    // Directory scans and metadata I/O remain off the async runtime. An
    // unchanged directory takes the cached index path (one directory stat),
    // while capture/download/delete invalidates it through directory mtime.
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::Path::new(&dir);
        if !path.exists() {
            return Ok(Vec::new());
        }
        let files = indexed_screenshot_paths(path)?;
        let offset = offset.unwrap_or(0);
        let limit = limit.unwrap_or(usize::MAX);
        Ok(files
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|entry| entry.path.to_string_lossy().into_owned())
            .collect())
    })
    .await
    .map_err(|e| format!("List task failed: {}", e))?
}

/// List a newest-first page across several screenshot directories. Existing
/// Desktop screenshots remain available after SyncShot moves new captures to
/// its private cache; this only reads directory metadata and never copies,
/// uploads, or decodes an image.
#[tauri::command]
pub async fn list_screenshots_from_dirs(
    dirs: Vec<String>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let offset = offset.unwrap_or(0);
        let limit = limit.unwrap_or(usize::MAX);
        Ok::<Vec<String>, String>(
            indexed_screenshot_paths_from_dirs(dirs)?
                .into_iter()
                .skip(offset)
                .take(limit)
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
        )
    })
    .await
    .map_err(|e| format!("List task failed: {}", e))?
}

/// List the local screenshot sources for the active SyncShot write directory.
/// Source selection happens natively, so it is reliable before React settings
/// and Firebase auth have hydrated.
#[tauri::command]
pub async fn list_screenshot_sources(
    dir: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let offset = offset.unwrap_or(0);
        let limit = limit.unwrap_or(usize::MAX);
        Ok::<Vec<String>, String>(
            indexed_screenshot_paths_from_dirs(screenshot_source_dirs(dir)?)?
                .into_iter()
                .skip(offset)
                .take(limit)
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
        )
    })
    .await
    .map_err(|e| format!("List task failed: {}", e))?
}

/// Get the system temp directory path (cross-platform)
/// Returns the canonical/resolved path to avoid symlink issues
#[tauri::command]
pub async fn get_temp_directory() -> Result<String, String> {
    let temp_dir = std::env::temp_dir();
    // Canonicalize to resolve symlinks (e.g., /tmp -> /private/tmp on macOS)
    let canonical = temp_dir.canonicalize().unwrap_or(temp_dir);
    canonical
        .to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Failed to convert temp directory path to string".to_string())
}

/// Return a cached, downscaled thumbnail of the screenshot at `path` as raw PNG
/// BYTES (via `tauri::ipc::Response`, so the frontend receives an ArrayBuffer —
/// not a JSON number array). Decode/resize/encode runs on a blocking thread so
/// fast scrolling (many concurrent calls) never stalls the async runtime.
///
/// Returns BYTES, not a file path, on purpose: the release webview's
/// `http://localhost:38217` origin cannot CORS-load an `asset://` path, so the
/// frontend builds a same-origin `blob:` URL from these bytes (works in dev AND
/// release). The on-disk thumbnail cache is still reused under the hood.
#[tauri::command]
pub async fn get_screenshot_thumbnail(
    path: String,
    max_px: u32,
) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        crate::image::screenshot_thumbnail_bytes(&path, max_px)
    })
    .await
    .map_err(|e| format!("Thumbnail task failed: {}", e))??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Return the on-disk PATH of the cached thumbnail for `path` (generating it
/// if missing — same cache and pipeline as `get_screenshot_thumbnail`). The
/// frontend hands this path to the OS as a native drag icon: the drag plugin
/// reads the file directly, so no bytes cross IPC. The bytes contract of
/// `get_screenshot_thumbnail` is unchanged.
#[tauri::command]
pub async fn get_screenshot_thumbnail_path(path: String, max_px: u32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::image::screenshot_thumbnail(&path, max_px))
        .await
        .map_err(|e| format!("Thumbnail task failed: {}", e))?
}

/// Return a LOCAL file's raw, FULL-RES bytes as `tauri::ipc::Response` (the
/// frontend receives an ArrayBuffer, not a JSON number array).
///
/// Why this exists: the release webview's `http://localhost:38217` origin
/// CANNOT CORS-load an `asset://` path, so the sync layer's old
/// `fetch(convertFileSrc(path))` REJECTS for local cache files in release —
/// breaking own-capture upload, the share-link button, and local-file probing.
/// Reading the bytes in Rust and handing them back over IPC is origin-
/// independent: it works in `tauri dev` AND the release localhost build. The
/// frontend wraps these bytes in a `Blob` and hashes/uploads exactly as before.
#[tauri::command]
pub async fn read_image_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        std::fs::read(&path).map_err(|e| format!("Failed to read {}: {}", path, e))
    })
    .await
    .map_err(|e| format!("Read task failed: {}", e))??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Return Firebase image bytes directly to the editor webview. The response is
/// raw IPC bytes, never a local screenshot file.
#[tauri::command]
pub async fn read_remote_image_bytes(url: String) -> Result<tauri::ipc::Response, String> {
    let bytes = fetch_synced_image_bytes(&url).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Cheap existence probe for a LOCAL file path. Used by the sync layer to ask
/// "is the local cache file still present?" without a CORS `asset://` fetch
/// (which always fails from the release localhost origin) and without reading
/// the whole file's bytes. Returns false on a missing file or any stat error.
/// Async so the stat runs on a runtime worker, not the main thread (a sync
/// command body executes on main — one slow/network volume stat = UI hitch).
#[tauri::command]
pub async fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).is_file()
}

/// File metadata for the sync backfill ledger: mtime (ms since epoch) + size.
/// Serializes as `{ "mtimeMs": <number>, "size": <number> }` — the exact shape
/// the frontend `FileStat` interface (src/lib/sync/backfillLedger.ts) expects.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub mtime_ms: u64,
    pub size: u64,
}

/// Stat a LOCAL file (mtime + size) for the sync layer's backfill ledger,
/// without reading any bytes and without a CORS `asset://` fetch (impossible
/// from the release localhost origin). Like `file_exists`, but returns real
/// metadata; the stat runs on a blocking thread so a slow/network volume never
/// stalls the async runtime.
#[tauri::command]
pub async fn stat_file(path: String) -> Result<FileStat, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let meta =
            std::fs::metadata(&path).map_err(|e| format!("Failed to stat {}: {}", path, e))?;
        let mtime_ms = meta
            .modified()
            .map_err(|e| format!("Failed to read mtime of {}: {}", path, e))?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("mtime of {} predates epoch: {}", path, e))?
            .as_millis() as u64;
        Ok(FileStat {
            mtime_ms,
            size: meta.len(),
        })
    })
    .await
    .map_err(|e| format!("Stat task failed: {}", e))?
}

/// Check if screencapture is already running
fn is_screencapture_running() -> bool {
    let output = Command::new("pgrep")
        .arg("-x")
        .arg("screencapture")
        .output();

    match output {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

/// Screen-recording permission gate. The old implementation ran a THROWAWAY
/// full-screen `screencapture -T 0` grab to a temp file on EVERY capture call
/// (~0.5–1s + disk churn) while holding SCREENCAPTURE_LOCK. Now: an instant
/// TCC lookup via CGPreflightScreenCaptureAccess, requesting access (one
/// system prompt) when not yet granted. A granted result is cached for the
/// app run; a denial is re-checked each call so granting in System Settings
/// mid-run is picked up without restart.
#[cfg(target_os = "macos")]
fn check_and_activate_permission() -> Result<(), String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    static GRANTED: AtomicBool = AtomicBool::new(false);
    if GRANTED.load(Ordering::Relaxed) {
        return Ok(());
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    let granted =
        unsafe { CGPreflightScreenCaptureAccess() } || unsafe { CGRequestScreenCaptureAccess() };
    if granted {
        GRANTED.store(true, Ordering::Relaxed);
        Ok(())
    } else {
        Err("Screen Recording permission not granted".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn check_and_activate_permission() -> Result<(), String> {
    Ok(())
}

/// Blocking body shared by the interactive (`-i`) and window (`-w`) captures.
/// Runs on the blocking pool: the screencapture session lasts as long as the
/// user takes to drag a selection / pick a window (minutes, possibly), and the
/// old inline `wait_with_output()` parked a tokio worker for the whole session
/// — with workers = core count, a couple of captures plus other inline
/// blocking exhausted the runtime and EVERY async command queued for seconds.
/// SCREENCAPTURE_LOCK is held for the session by design (one capture UI at a
/// time); a std Mutex is fine now that waiters park blocking-pool threads.
fn native_capture_blocking(save_dir: &str, mode_flag: &str) -> Result<String, String> {
    let _lock = SCREENCAPTURE_LOCK
        .lock()
        .map_err(|e| format!("Failed to acquire lock: {}", e))?;

    if is_screencapture_running() {
        return Err("Another screenshot capture is already in progress".to_string());
    }

    check_and_activate_permission().map_err(|e| {
        format!("Permission check failed: {}. Please ensure Screen Recording permission is granted in System Settings > Privacy & Security > Screen Recording.", e)
    })?;

    let filename = generate_filename("screenshot", "png")?;
    let screenshot_path = PathBuf::from(save_dir).join(&filename);
    let path_str = screenshot_path.to_string_lossy().to_string();

    let child = Command::new("screencapture")
        .arg(mode_flag)
        .arg("-x")
        // `-o`: in window-capture mode, omit the window's drop shadow. macOS bakes
        // the shadow into a wide TRANSPARENT margin around the window, which the
        // editor renders as unwanted black padding. Safe to always pass — it only
        // affects window capture (no-op for interactive rectangle-region grabs).
        .arg("-o")
        .arg(&path_str)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run screencapture: {}", e))?;

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for screencapture: {}", e))?;

    if !output.status.success() {
        if screenshot_path.exists() {
            let _ = std::fs::remove_file(&screenshot_path);
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("permission")
            || stderr.contains("denied")
            || stderr.contains("not authorized")
        {
            return Err("Screen Recording permission required. Please grant permission in System Settings > Privacy & Security > Screen Recording and restart the app.".to_string());
        }
        return Err("Screenshot was cancelled or failed".to_string());
    }

    if screenshot_path.exists() {
        Ok(path_str)
    } else {
        Err("Screenshot was cancelled or failed".to_string())
    }
}

/// Capture screenshot using macOS native screencapture with interactive selection
/// This properly handles Screen Recording permissions through the system
#[tauri::command]
pub async fn native_capture_interactive(save_dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || native_capture_blocking(&save_dir, "-i"))
        .await
        .map_err(|e| format!("Capture task failed: {}", e))?
}

/// Minimal CoreGraphics FFI used to find which display the cursor is on so a
/// full-screen capture grabs THAT display (not always the main one) in a
/// multi-monitor setup. We link the frameworks directly to avoid pulling in the
/// `core-graphics` crate; objc2 already links these on macOS.
#[cfg(target_os = "macos")]
mod cg_cursor {
    use std::os::raw::c_void;

    pub type CGDirectDisplayID = u32;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CGPoint {
        pub x: f64,
        pub y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CGSize {
        pub width: f64,
        pub height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CGRect {
        pub origin: CGPoint,
        pub size: CGSize,
    }

    type CGEventRef = *mut c_void;
    type CGEventSourceRef = *mut c_void;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        // Passing a NULL source yields an event carrying the CURRENT cursor
        // location — no accessibility permission required.
        fn CGEventCreate(source: CGEventSourceRef) -> CGEventRef;
        fn CGEventGetLocation(event: CGEventRef) -> CGPoint;
        // Finds the display(s) whose bounds contain `point`.
        fn CGGetDisplaysWithPoint(
            point: CGPoint,
            max_displays: u32,
            displays: *mut CGDirectDisplayID,
            matching_display_count: *mut u32,
        ) -> i32; // CGError; 0 == success
                  // Bounds in the GLOBAL display coordinate space: top-left origin,
                  // relative to the upper-left corner of the MAIN display, in points.
                  // This is exactly the space `screencapture -R<x,y,w,h>` expects.
        fn CGDisplayBounds(display: CGDirectDisplayID) -> CGRect;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
    }

    /// Convenience constructor so callers (e.g. Tauri commands) can build a
    /// `CGPoint` without naming the framework struct's repr details.
    pub fn point(x: f64, y: f64) -> CGPoint {
        CGPoint { x, y }
    }

    /// Returns the integer (x, y, width, height) rect — in the global,
    /// top-left-origin display coordinate space, in POINTS — of the display
    /// whose bounds contain `point`. `None` if no display contains the point.
    pub fn display_rect_for_point(point: CGPoint) -> Option<(i64, i64, i64, i64)> {
        unsafe {
            let mut display: CGDirectDisplayID = 0;
            let mut count: u32 = 0;
            let err = CGGetDisplaysWithPoint(point, 1, &mut display, &mut count);
            if err != 0 || count == 0 {
                return None;
            }

            let bounds = CGDisplayBounds(display);
            let w = bounds.size.width.round() as i64;
            let h = bounds.size.height.round() as i64;
            if w <= 0 || h <= 0 {
                return None;
            }
            Some((
                bounds.origin.x.round() as i64,
                bounds.origin.y.round() as i64,
                w,
                h,
            ))
        }
    }

    /// Returns AppKit's usable display rectangle (the NSScreen visibleFrame)
    /// in the same global, top-left-origin POINT coordinate space as
    /// `CGDisplayBounds`. Unlike Tauri 2.9's macOS `Monitor.workArea`, this
    /// retains the vertical origin, so menu-bar and Dock insets stay distinct.
    pub fn visible_display_rect_for_point(point: CGPoint) -> Option<(i64, i64, i64, i64)> {
        use objc2_app_kit::NSScreen;
        use objc2_modern::MainThreadMarker;

        let mtm = MainThreadMarker::new()?;
        let screens = NSScreen::screens(mtm);
        // AppKit's global display space is bottom-left-origin, while
        // CoreGraphics/Tauri window positions are top-left-origin. The Y-axis
        // conversion must always use the PRIMARY display (frame origin 0,0) as
        // its baseline. `NSScreen::mainScreen` is the screen containing the key
        // window and changes as focus moves between monitors; using its height
        // shifted the pill vertically whenever that monitor had a different
        // height from the primary display.
        let coordinate_base_height = screens.iter().find_map(|screen| {
            let frame = screen.frame();
            (frame.origin.x.abs() < 0.5 && frame.origin.y.abs() < 0.5).then_some(frame.size.height)
        })?;

        for screen in screens.iter() {
            let frame = screen.frame();
            let left = frame.origin.x;
            let top = coordinate_base_height - frame.origin.y - frame.size.height;
            let right = left + frame.size.width;
            let bottom = top + frame.size.height;
            if point.x < left || point.x >= right || point.y < top || point.y >= bottom {
                continue;
            }

            let visible = screen.visibleFrame();
            let visible_top = coordinate_base_height - visible.origin.y - visible.size.height;
            let width = visible.size.width.round() as i64;
            let height = visible.size.height.round() as i64;
            if width <= 0 || height <= 0 {
                return None;
            }
            return Some((
                visible.origin.x.round() as i64,
                visible_top.round() as i64,
                width,
                height,
            ));
        }
        None
    }

    /// AppKit visibleFrame for the display currently under the cursor.
    pub fn cursor_visible_display_rect() -> Option<(i64, i64, i64, i64)> {
        unsafe {
            let event = CGEventCreate(std::ptr::null_mut());
            if event.is_null() {
                return None;
            }
            let point = CGEventGetLocation(event);
            CFRelease(event as *const c_void);
            visible_display_rect_for_point(point)
        }
    }

    /// Returns the integer (x, y, width, height) rect — in the global,
    /// top-left-origin display coordinate space — of the display currently
    /// under the cursor. `None` if the cursor isn't over any display (capture
    /// then falls back to the default main-display behavior).
    pub fn cursor_display_rect() -> Option<(i64, i64, i64, i64)> {
        unsafe {
            let event = CGEventCreate(std::ptr::null_mut());
            if event.is_null() {
                return None;
            }
            let point = CGEventGetLocation(event);
            CFRelease(event as *const c_void);
            display_rect_for_point(point)
        }
    }

    /// Returns the current cursor location in the GLOBAL, top-left-origin display
    /// coordinate space, in POINTS (logical) — exactly the space the JS hit-test
    /// expects (it compares against `availableMonitors` position/scaleFactor), so
    /// no Y flip or rescale is applied. `None` if the event can't be created.
    pub fn cursor_location() -> Option<(f64, f64)> {
        unsafe {
            let event = CGEventCreate(std::ptr::null_mut());
            if event.is_null() {
                return None;
            }
            let p = CGEventGetLocation(event);
            CFRelease(event as *const c_void);
            Some((p.x, p.y))
        }
    }
}

/// Capture full screen using macOS native screencapture.
///
/// Multi-monitor: captures the display the CURSOR is currently on (via
/// `screencapture -R` over the cursor display's CGDisplayBounds), instead of
/// always grabbing the main display. Single-display setups are unaffected — the
/// cursor's display IS the main display, whose bounds (0,0,W,H) capture the
/// whole screen, identical to the old behavior.
#[tauri::command]
pub async fn native_capture_fullscreen(save_dir: String) -> Result<String, String> {
    // Blocking subprocess wait + lock: run on the blocking pool (see
    // native_capture_blocking for why).
    tauri::async_runtime::spawn_blocking(move || native_capture_fullscreen_blocking(&save_dir))
        .await
        .map_err(|e| format!("Capture task failed: {}", e))?
}

fn native_capture_fullscreen_blocking(save_dir: &str) -> Result<String, String> {
    let _lock = SCREENCAPTURE_LOCK
        .lock()
        .map_err(|e| format!("Failed to acquire lock: {}", e))?;

    if is_screencapture_running() {
        return Err("Another screenshot capture is already in progress".to_string());
    }

    check_and_activate_permission().map_err(|e| {
        format!("Permission check failed: {}. Please ensure Screen Recording permission is granted in System Settings > Privacy & Security > Screen Recording.", e)
    })?;

    let filename = generate_filename("screenshot", "png")?;
    let screenshot_path = PathBuf::from(save_dir).join(&filename);
    let path_str = screenshot_path.to_string_lossy().to_string();

    // `-x` = do not play sound (the frontend plays it separately); preserved.
    // On macOS, restrict the capture to the rect of the cursor's display so a
    // full-screen shot follows the cursor across monitors.
    let mut cmd = Command::new("screencapture");
    cmd.arg("-x");
    #[cfg(target_os = "macos")]
    {
        if let Some((x, y, w, h)) = cg_cursor::cursor_display_rect() {
            eprintln!(
                "[capture] fullscreen → cursor display rect -R{},{},{},{}",
                x, y, w, h
            );
            cmd.arg(format!("-R{},{},{},{}", x, y, w, h));
        }
    }
    let status = cmd
        .arg(&path_str)
        .status()
        .map_err(|e| format!("Failed to run screencapture: {}", e))?;

    if !status.success() {
        return Err("Screenshot failed".to_string());
    }

    if screenshot_path.exists() {
        Ok(path_str)
    } else {
        Err("Screenshot failed".to_string())
    }
}

/// Play the macOS screenshot sound
#[tauri::command]
pub async fn play_screenshot_sound() -> Result<(), String> {
    // macOS system screenshot sound path
    let sound_path = "/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/system/Screen Capture.aif";

    // Use afplay to play the sound asynchronously (non-blocking)
    std::thread::spawn(move || {
        let _ = Command::new("afplay")
            .arg(sound_path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    });

    Ok(())
}

/// Get the current mouse cursor position (for determining which screen to open editor on).
///
/// Reads the real cursor location via CoreGraphics (`CGEventGetLocation`), which
/// returns GLOBAL top-left-origin coordinates in points — exactly what the JS
/// multi-monitor hit-test expects. (The old `osascript`/System Events path always
/// errored: System Events has no `mouse` property.)
#[tauri::command]
pub async fn get_mouse_position() -> Result<(f64, f64), String> {
    #[cfg(target_os = "macos")]
    {
        match cg_cursor::cursor_location() {
            Some((x, y)) => Ok((x, y)),
            None => Err("Failed to get mouse position".to_string()),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("unsupported".into())
    }
}

/// Returns the usable (x, y, width, height) rect — in the GLOBAL,
/// top-left-origin display coordinate space, in POINTS (logical) — of the
/// display containing the given point, or the display under the cursor when no
/// point is supplied. On macOS this is NSScreen.visibleFrame: below the menu bar
/// and above/alongside the Dock.
/// This is the same coordinate space Tauri's `LogicalPosition`/`LogicalSize`
/// use, so the frontend can place windows on the correct physical display
/// regardless of mixed per-display scale factors.
#[tauri::command]
pub fn cursor_display_bounds(x: Option<f64>, y: Option<f64>) -> Option<(i64, i64, i64, i64)> {
    #[cfg(target_os = "macos")]
    {
        match (x, y) {
            (Some(px), Some(py)) => {
                cg_cursor::visible_display_rect_for_point(cg_cursor::point(px, py))
            }
            _ => cg_cursor::cursor_visible_display_rect(),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (x, y);
        None
    }
}

/// Capture specific window using macOS native screencapture
#[tauri::command]
pub async fn native_capture_window(save_dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || native_capture_blocking(&save_dir, "-w"))
        .await
        .map_err(|e| format!("Capture task failed: {}", e))?
}
