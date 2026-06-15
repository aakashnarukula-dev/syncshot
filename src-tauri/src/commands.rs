//! Tauri commands module

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::AppHandle;

use crate::clipboard::copy_image_to_clipboard;
use crate::image::{copy_screenshot_to_dir, crop_image, save_base64_image, save_base64_image_to_path, CropRegion};
use std::fs;
use crate::screenshot::{
    capture_all_monitors as capture_monitors, capture_primary_monitor, MonitorShot,
};
use crate::utils::{generate_filename, get_desktop_path, get_screenshotx_dir};

static SCREENCAPTURE_LOCK: Mutex<()> = Mutex::new(());

/// Quick capture of primary monitor
#[tauri::command]
pub async fn capture_once(
    app_handle: AppHandle,
    save_dir: String,
    copy_to_clip: bool,
) -> Result<String, String> {
    let screenshot_path = capture_primary_monitor(app_handle).await?;
    let screenshot_path_str = screenshot_path.to_string_lossy().to_string();

    let saved_path = copy_screenshot_to_dir(&screenshot_path_str, &save_dir)?;

    if copy_to_clip {
        copy_image_to_clipboard(&saved_path)?;
    }

    Ok(saved_path)
}

/// Capture all monitors with geometry info
#[tauri::command]
pub async fn capture_all_monitors(
    _app_handle: AppHandle,
    save_dir: String,
) -> Result<Vec<MonitorShot>, String> {
    capture_monitors(&save_dir)
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
    crop_image(&screenshot_path, region, &save_dir)
}

/// Save a native screenshot file to the user's save dir and optionally copy to clipboard
#[tauri::command]
pub async fn save_native_screenshot(
    app: AppHandle,
    source_path: String,
    save_dir: String,
    copy_to_clip: bool,
) -> Result<String, String> {
    let saved_path = copy_screenshot_to_dir(&source_path, &save_dir)?;
    if copy_to_clip {
        copy_image_to_clipboard(&saved_path)?;
    }
    // Notify the webview so the Firebase sync engine can upload this capture.
    // (The publisher dedupes by sha256, so a spurious emit is harmless.)
    use tauri::Emitter;
    let _ = app.emit("new-screenshot", saved_path.clone());
    Ok(saved_path)
}

/// Save a screenshot received via Firebase sync into the local screenshot cache
/// (hidden app-data dir, NOT the Desktop) and copy it to the clipboard. Returns
/// the saved file path. The existing save-dir poll then surfaces it in the
/// thumbnail column.
#[tauri::command]
pub async fn save_synced_image(bytes: Vec<u8>, name: String) -> Result<String, String> {
    persist_synced_image(&bytes, &name)
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

/// Persist raw image bytes into the local screenshot cache (hidden app-data dir,
/// NOT the Desktop) and copy them to the clipboard. Returns the saved path.
/// Shared by `save_synced_image` (bytes over IPC) and `download_synced_image`
/// (bytes fetched in Rust).
fn persist_synced_image(bytes: &[u8], name: &str) -> Result<String, String> {
    let dir = get_screenshotx_dir()?;
    let filename = synced_filename_for(name, bytes)?;
    let path = PathBuf::from(&dir).join(&filename);
    fs::write(&path, bytes).map_err(|e| format!("Failed to save synced image: {}", e))?;
    let path_str = path.to_string_lossy().into_owned();
    // Mirror local-capture behavior: place the received image on the clipboard.
    let _ = copy_image_to_clipboard(&path_str);
    Ok(path_str)
}

/// Download a synced screenshot's bytes over HTTP from a Firebase Storage
/// download URL and persist it into the local cache (same destination as
/// `save_synced_image`). Returns the saved path.
///
/// The receive path resolves a tokenized `getDownloadURL()` in the webview — a
/// capability URL that bypasses Storage security rules AND CORS — then hands it
/// here. Fetching the raw bytes in Rust sidesteps the webview's CORS sandbox:
/// `getBytes()`/`getBlob()` issue a cross-origin XHR the bucket blocks without
/// CORS config, but Rust HTTP is not subject to webview CORS, so cross-device
/// receives (e.g. an Android upload landing on this Mac) work with ZERO
/// bucket-CORS setup.
#[tauri::command]
pub async fn download_synced_image(url: String, name: String) -> Result<String, String> {
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to fetch synced image: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Failed to fetch synced image: HTTP {}",
            resp.status()
        ));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read synced image body: {}", e))?;
    persist_synced_image(&bytes, &name)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(synced_filename_for("doc123.png", &jpeg).unwrap(), "doc123.jpg");

        let png = b"\x89PNG\r\n\x1a\n";
        assert_eq!(synced_filename_for("doc123.png", png).unwrap(), "doc123.png");

        let webp = b"RIFF\x24\x00\x00\x00WEBPVP8 ";
        assert_eq!(synced_filename_for("doc123.png", webp).unwrap(), "doc123.webp");
    }

    #[test]
    fn synced_filename_keeps_name_when_type_unknown() {
        // Unrecognized bytes leave the (sanitized) requested name untouched.
        assert_eq!(
            synced_filename_for("doc123.png", b"not an image").unwrap(),
            "doc123.png"
        );
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
    copy_image_to_clipboard(&path)
}

/// Delete a file (used to remove the temp capture once saved)
#[tauri::command]
pub async fn delete_file(path: String) -> Result<(), String> {
    if std::path::Path::new(&path).exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete file: {}", e))?;
    }
    Ok(())
}

/// Open a borderless editor window for the given screenshot path.
#[tauri::command]
pub async fn open_editor_window(
    app: tauri::AppHandle,
    label: String,
    image_path: String,
) -> Result<(), String> {
    use tauri::{TitleBarStyle, WebviewUrl, WebviewWindowBuilder};
    let encoded = urlencoding::encode(&image_path);
    let url_path = format!("?editor={}", encoded);
    let _win = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url_path.into()))
        .inner_size(900.0, 700.0)
        .decorations(true)
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .title("")
        .resizable(true)
        .center()
        .focused(true)
        .build()
        .map_err(|e| format!("Failed to open editor window: {}", e))?;
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
    let saved_path = match overwrite_path {
        Some(ref p) if !p.is_empty() => save_base64_image_to_path(&image_data, p)?,
        _ => save_base64_image(&image_data, &save_dir, "screenshotx")?,
    };

    if copy_to_clip {
        copy_image_to_clipboard(&saved_path)?;
    }

    Ok(saved_path)
}

/// Get the default screenshot directory: a hidden app-data cache (NOT the
/// Desktop). Firebase Storage is the source of truth; this dir is the local
/// cache that backs the pill column / editor / clipboard-paste. Created if
/// missing. (Command name kept for IPC compatibility with the frontend.)
#[tauri::command]
pub async fn get_desktop_directory() -> Result<String, String> {
    get_screenshotx_dir()
}

/// Get the raw user Desktop path (no subfolder). Used to detect legacy save dirs.
#[tauri::command]
pub async fn get_desktop_root() -> Result<String, String> {
    get_desktop_path()
}

/// List screenshot files in a directory, newest first.
#[tauri::command]
pub async fn list_screenshots(dir: String) -> Result<Vec<String>, String> {
    let path = std::path::Path::new(&dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(path).map_err(|e| format!("Failed to read dir: {}", e))?;
    let mut files: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        if !matches!(
            ext.as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "heic"
        ) {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        files.push((p, mtime));
    }
    files.sort_by(|a, b| b.1.cmp(&a.1));
    Ok(files
        .into_iter()
        .map(|(p, _)| p.to_string_lossy().into_owned())
        .collect())
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

/// Return a cached, downscaled thumbnail path for the screenshot at `path`.
/// Decode/resize/encode runs on a blocking thread so fast scrolling (many
/// concurrent calls) never stalls the async runtime.
#[tauri::command]
pub async fn get_screenshot_thumbnail(path: String, max_px: u32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::image::screenshot_thumbnail(&path, max_px)
    })
    .await
    .map_err(|e| format!("Thumbnail task failed: {}", e))?
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

/// Check screen recording permission by attempting a minimal test
/// This helps macOS recognize the permission is already granted
fn check_and_activate_permission() -> Result<(), String> {
    let test_path = std::env::temp_dir().join(format!("bs_test_{}.png", std::process::id()));

    let output = Command::new("screencapture")
        .arg("-x")
        .arg("-T")
        .arg("0")
        .arg(&test_path)
        .stderr(Stdio::piped())
        .stdout(Stdio::piped())
        .output();

    match output {
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            let _ = std::fs::remove_file(&test_path);

            if stderr.contains("permission")
                || stderr.contains("denied")
                || stderr.contains("not authorized")
            {
                return Err("Screen Recording permission not granted".to_string());
            }

            Ok(())
        }
        Err(e) => {
            let err_msg = e.to_string();
            if err_msg.contains("permission")
                || err_msg.contains("denied")
                || err_msg.contains("not authorized")
            {
                Err("Screen Recording permission not granted".to_string())
            } else {
                Ok(())
            }
        }
    }
}

/// Capture screenshot using macOS native screencapture with interactive selection
/// This properly handles Screen Recording permissions through the system
#[tauri::command]
pub async fn native_capture_interactive(save_dir: String) -> Result<String, String> {
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
    let save_path = PathBuf::from(&save_dir);
    let screenshot_path = save_path.join(&filename);
    let path_str = screenshot_path.to_string_lossy().to_string();

    let child = Command::new("screencapture")
        .arg("-i")
        .arg("-x")
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

/// Capture full screen using macOS native screencapture
#[tauri::command]
pub async fn native_capture_fullscreen(save_dir: String) -> Result<String, String> {
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
    let save_path = PathBuf::from(&save_dir);
    let screenshot_path = save_path.join(&filename);
    let path_str = screenshot_path.to_string_lossy().to_string();

    let status = Command::new("screencapture")
        .arg("-x")
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

/// Get the current mouse cursor position (for determining which screen to open editor on)
#[tauri::command]
pub async fn get_mouse_position() -> Result<(f64, f64), String> {
    // Use AppleScript to get mouse position - it's the most reliable cross-version approach
    let output = Command::new("osascript")
        .arg("-e")
        .arg("tell application \"System Events\" to return (get position of mouse)")
        .output()
        .map_err(|e| format!("Failed to get mouse position: {}", e))?;

    if !output.status.success() {
        return Err("Failed to get mouse position".to_string());
    }

    let position_str = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<&str> = position_str.trim().split(", ").collect();

    if parts.len() != 2 {
        return Err("Invalid mouse position format".to_string());
    }

    let x: f64 = parts[0]
        .parse()
        .map_err(|_| "Failed to parse X coordinate")?;
    let y: f64 = parts[1]
        .parse()
        .map_err(|_| "Failed to parse Y coordinate")?;

    Ok((x, y))
}

/// Capture specific window using macOS native screencapture
#[tauri::command]
pub async fn native_capture_window(save_dir: String) -> Result<String, String> {
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
    let save_path = PathBuf::from(&save_dir);
    let screenshot_path = save_path.join(&filename);
    let path_str = screenshot_path.to_string_lossy().to_string();

    let child = Command::new("screencapture")
        .arg("-w")
        .arg("-x")
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
