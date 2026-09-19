//! Clipboard operations module

use crate::utils::AppResult;
use serde::Serialize;

/// Payload for the `clipboard-changed` Tauri event emitted by the watcher.
#[derive(Clone, Serialize)]
struct ClipboardChanged {
    text: String,
}

/// Copy an image file to the system clipboard as self-contained image data.
///
/// Do not advertise the staging path as `public.file-url`: captures and editor
/// exports are deleted after their Firebase upload. Apps which preferred that
/// representation could paste once while the file existed and then fail on the
/// next paste. NSPasteboard owns the bytes written below, so repeated pastes
/// remain valid after the staging file is removed.
#[cfg(target_os = "macos")]
pub fn copy_image_to_clipboard(image_path: &str) -> AppResult<()> {
    let bytes = std::fs::read(image_path).map_err(|e| format!("read image: {}", e))?;
    write_image_to_clipboard(&bytes)
}

/// Copy image bytes without creating a local file. Cloud screenshots use this
/// path so Firebase remains the only persistent screenshot store on the Mac.
#[cfg(target_os = "macos")]
pub fn copy_image_bytes_to_clipboard(bytes: &[u8]) -> AppResult<()> {
    write_image_to_clipboard(bytes)
}

#[cfg(target_os = "macos")]
static IMAGE_CLIPBOARD_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// PNG is the most consistently accepted in-memory image representation across
/// AppKit, Chromium and Electron targets. Keep the real encoded representation
/// too (important for JPEG/GIF/WebP/HEIC), and add PNG when the image crate can
/// decode the source without touching disk.
#[cfg(target_os = "macos")]
fn png_clipboard_fallback(bytes: &[u8]) -> Option<Vec<u8>> {
    if crate::image::detect_image_kind(bytes) == Some(crate::image::ImageKind::Png) {
        return None;
    }
    let decoded = image::load_from_memory(bytes).ok()?;
    let mut output = std::io::Cursor::new(Vec::new());
    decoded
        .write_to(&mut output, image::ImageOutputFormat::Png)
        .ok()?;
    Some(output.into_inner())
}

#[cfg(target_os = "macos")]
fn write_image_to_clipboard(bytes: &[u8]) -> AppResult<()> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use std::ffi::CString;

    if bytes.is_empty() {
        return Err("Cannot copy an empty image".to_string());
    }

    // Serialize clear+write as one operation. Auto-copy, editor save and a tile
    // copy can otherwise interleave on worker threads and leave a partial set
    // of pasteboard representations behind.
    let _write_guard = IMAGE_CLIPBOARD_LOCK
        .lock()
        .map_err(|_| "Image clipboard lock was poisoned".to_string())?;

    // Tag the original bytes with their real UTI. Unrecognized bytes are
    // rejected instead of being mislabeled as PNG and reported as a success.
    let image_kind = crate::image::detect_image_kind(bytes)
        .ok_or_else(|| "Unsupported or invalid image data".to_string())?;
    let image_uti = image_kind.pasteboard_uti();
    let png_fallback = png_clipboard_fallback(bytes);
    let c_image_type = CString::new(image_uti).unwrap();
    let c_png_type = CString::new("public.png").unwrap();

    unsafe {
        let ns_pasteboard_cls = objc2::runtime::AnyClass::get("NSPasteboard")
            .ok_or_else(|| "NSPasteboard class not found".to_string())?;
        let ns_string_cls = objc2::runtime::AnyClass::get("NSString")
            .ok_or_else(|| "NSString class not found".to_string())?;
        let ns_data_cls = objc2::runtime::AnyClass::get("NSData")
            .ok_or_else(|| "NSData class not found".to_string())?;

        let pasteboard: *mut AnyObject = msg_send![ns_pasteboard_cls, generalPasteboard];
        if pasteboard.is_null() {
            return Err("Failed to get general pasteboard".to_string());
        }

        // NSData copies the source buffer; the pasteboard is independent of the
        // Rust Vec and of any temporary capture/editor file.
        let data: *mut AnyObject = msg_send![
            ns_data_cls,
            dataWithBytes: bytes.as_ptr() as *const std::ffi::c_void,
            length: bytes.len()
        ];

        let image_type: *mut AnyObject =
            msg_send![ns_string_cls, stringWithUTF8String: c_image_type.as_ptr()];

        // Clear once, then atomically (under our process lock) add every
        // self-contained representation. Check Cocoa's BOOL results so the UI
        // never displays a false "Copied" success.
        let _: i64 = msg_send![pasteboard, clearContents];
        let original_written: bool = msg_send![pasteboard, setData: data, forType: image_type];
        if !original_written {
            return Err(format!(
                "Failed to write {image_uti} image data to clipboard"
            ));
        }

        if let Some(png_bytes) = png_fallback.as_ref() {
            let png_data: *mut AnyObject = msg_send![
                ns_data_cls,
                dataWithBytes: png_bytes.as_ptr() as *const std::ffi::c_void,
                length: png_bytes.len()
            ];
            let png_type: *mut AnyObject =
                msg_send![ns_string_cls, stringWithUTF8String: c_png_type.as_ptr()];
            let png_written: bool = msg_send![pasteboard, setData: png_data, forType: png_type];
            if !png_written {
                return Err("Failed to write PNG clipboard fallback".to_string());
            }
        }
    }

    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod image_clipboard_tests {
    use super::png_clipboard_fallback;

    #[test]
    fn png_needs_no_duplicate_fallback() {
        let png = include_bytes!("../icons/32x32.png");
        assert!(png_clipboard_fallback(png).is_none());
    }

    #[test]
    fn jpeg_gets_a_valid_png_fallback() {
        let image = image::DynamicImage::new_rgb8(2, 2);
        let mut jpeg = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut jpeg, image::ImageOutputFormat::Jpeg(80))
            .unwrap();

        let png = png_clipboard_fallback(jpeg.get_ref()).expect("PNG fallback");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(image::load_from_memory(&png).unwrap().width(), 2);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn copy_image_to_clipboard(_image_path: &str) -> AppResult<()> {
    Err("clipboard image copy is only implemented on macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn copy_image_bytes_to_clipboard(_bytes: &[u8]) -> AppResult<()> {
    Err("clipboard image copy is only implemented on macOS".to_string())
}

/// Public UTI for plain UTF-8 text on the pasteboard.
#[cfg(target_os = "macos")]
const UTF8_PLAIN_TEXT: &str = "public.utf8-plain-text";

/// Read `NSPasteboard.changeCount` (monotonically increasing per change).
/// Returns -1 if the pasteboard can't be reached.
#[cfg(target_os = "macos")]
fn pasteboard_change_count() -> i64 {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    unsafe {
        let cls = match objc2::runtime::AnyClass::get("NSPasteboard") {
            Some(c) => c,
            None => return -1,
        };
        let pb: *mut AnyObject = msg_send![cls, generalPasteboard];
        if pb.is_null() {
            return -1;
        }
        let count: i64 = msg_send![pb, changeCount];
        count
    }
}

/// Read the current plain-text string from the pasteboard, if any (None when
/// the clipboard holds non-text content such as an image).
#[cfg(target_os = "macos")]
fn pasteboard_string() -> Option<String> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use std::ffi::{CStr, CString};
    unsafe {
        let pb_cls = objc2::runtime::AnyClass::get("NSPasteboard")?;
        let str_cls = objc2::runtime::AnyClass::get("NSString")?;
        let pb: *mut AnyObject = msg_send![pb_cls, generalPasteboard];
        if pb.is_null() {
            return None;
        }
        let c_type = CString::new(UTF8_PLAIN_TEXT).ok()?;
        let ns_type: *mut AnyObject = msg_send![str_cls, stringWithUTF8String: c_type.as_ptr()];
        let ns_str: *mut AnyObject = msg_send![pb, stringForType: ns_type];
        if ns_str.is_null() {
            return None;
        }
        let utf8: *const std::os::raw::c_char = msg_send![ns_str, UTF8String];
        if utf8.is_null() {
            return None;
        }
        Some(CStr::from_ptr(utf8).to_string_lossy().into_owned())
    }
}

/// Spawn a background thread that polls `NSPasteboard.changeCount` (~400 ms) and
/// emits a `clipboard-changed { text }` Tauri event whenever the clipboard text
/// changes. The React webview dedupes + publishes to Firebase.
#[cfg(target_os = "macos")]
pub fn start_clipboard_watcher(app: tauri::AppHandle) {
    use tauri::Emitter;
    std::thread::spawn(move || {
        // Seed with the current count so we don't immediately re-emit whatever
        // already happens to be on the clipboard at launch.
        let mut last = pasteboard_change_count();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(400));
            let count = pasteboard_change_count();
            if count == last {
                continue;
            }
            last = count;
            if let Some(text) = pasteboard_string() {
                if !text.is_empty() {
                    let _ = app.emit("clipboard-changed", ClipboardChanged { text });
                }
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn start_clipboard_watcher(_app: tauri::AppHandle) {}

/// Write a plain-text string to the system clipboard (re-copy a past entry).
#[cfg(target_os = "macos")]
pub fn set_clipboard_string(text: &str) -> AppResult<()> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use std::ffi::CString;

    let c_text = CString::new(text).map_err(|e| format!("text cstring: {}", e))?;
    let c_type = CString::new(UTF8_PLAIN_TEXT).unwrap();

    unsafe {
        let pb_cls = objc2::runtime::AnyClass::get("NSPasteboard")
            .ok_or_else(|| "NSPasteboard class not found".to_string())?;
        let str_cls = objc2::runtime::AnyClass::get("NSString")
            .ok_or_else(|| "NSString class not found".to_string())?;

        let pb: *mut AnyObject = msg_send![pb_cls, generalPasteboard];
        if pb.is_null() {
            return Err("Failed to get general pasteboard".to_string());
        }

        let ns_text: *mut AnyObject = msg_send![str_cls, stringWithUTF8String: c_text.as_ptr()];
        let ns_type: *mut AnyObject = msg_send![str_cls, stringWithUTF8String: c_type.as_ptr()];

        let _: i64 = msg_send![pb, clearContents];
        let ok: bool = msg_send![pb, setString: ns_text, forType: ns_type];
        if !ok {
            return Err("Failed to set clipboard string".to_string());
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn set_clipboard_string(_text: &str) -> AppResult<()> {
    Err("clipboard text set is only implemented on macOS".to_string())
}
