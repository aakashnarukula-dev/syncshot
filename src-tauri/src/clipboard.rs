//! Clipboard operations module

use crate::utils::AppResult;

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
