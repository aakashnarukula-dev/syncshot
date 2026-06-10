//! Clipboard operations module

use crate::utils::AppResult;
use serde::Serialize;

/// Payload for the `clipboard-changed` Tauri event emitted by the watcher.
#[derive(Clone, Serialize)]
struct ClipboardChanged {
    text: String,
}

/// Copy an image file to the system clipboard with BOTH:
///   - PNG image data (pastes as image into Messages, Slack, Notes, etc.)
///   - file URL (pastes as a file copy into Finder)
#[cfg(target_os = "macos")]
pub fn copy_image_to_clipboard(image_path: &str) -> AppResult<()> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use std::ffi::CString;

    let bytes = std::fs::read(image_path).map_err(|e| format!("read image: {}", e))?;
    let c_png_type = CString::new("public.png").unwrap();
    let c_file_url_type = CString::new("public.file-url").unwrap();
    let file_url_str = format!("file://{}", urlencoding::encode(image_path).replace("%2F", "/"));
    let c_file_url = CString::new(file_url_str).map_err(|e| format!("url cstring: {}", e))?;

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

        // NSData for the PNG bytes
        let data: *mut AnyObject = msg_send![
            ns_data_cls,
            dataWithBytes: bytes.as_ptr() as *const std::ffi::c_void,
            length: bytes.len()
        ];

        // NSString for the file-url string (file:// form)
        let ns_file_url_string: *mut AnyObject =
            msg_send![ns_string_cls, stringWithUTF8String: c_file_url.as_ptr()];

        // PNG and file-url types
        let png_type: *mut AnyObject =
            msg_send![ns_string_cls, stringWithUTF8String: c_png_type.as_ptr()];
        let file_url_type: *mut AnyObject =
            msg_send![ns_string_cls, stringWithUTF8String: c_file_url_type.as_ptr()];

        // Clear pasteboard, then write both types
        let _: i64 = msg_send![pasteboard, clearContents];
        let _: bool = msg_send![pasteboard, setData: data, forType: png_type];
        let _: bool = msg_send![pasteboard, setString: ns_file_url_string, forType: file_url_type];
    }

    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn copy_image_to_clipboard(_image_path: &str) -> AppResult<()> {
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

        let ns_text: *mut AnyObject =
            msg_send![str_cls, stringWithUTF8String: c_text.as_ptr()];
        let ns_type: *mut AnyObject =
            msg_send![str_cls, stringWithUTF8String: c_type.as_ptr()];

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
