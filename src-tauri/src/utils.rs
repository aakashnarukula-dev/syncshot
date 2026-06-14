//! Utility functions for common operations

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Custom error type for better error handling
pub type AppResult<T> = Result<T, String>;

/// Get the user's Desktop directory path (cross-platform)
pub fn get_desktop_path() -> AppResult<String> {
    let desktop = dirs::desktop_dir().ok_or("Failed to get Desktop directory")?;
    Ok(desktop.to_string_lossy().into_owned())
}

/// Get the ScreenshotX local screenshot directory. Created if missing.
///
/// Firebase Storage is the source of truth for synced screenshots; this is a
/// hidden, app-private cache (NOT a user-visible Desktop folder) under
/// ~/Library/Application Support so the pill column, the editor and
/// clipboard-paste have fast local access to recently captured/synced bytes.
/// Falls back to a temp-dir subfolder if the data dir can't be resolved.
pub fn get_screenshotx_dir() -> AppResult<String> {
    let base = dirs::data_dir().unwrap_or_else(std::env::temp_dir);
    let dir = base
        .join("com.aakashnarukula.screenshotx")
        .join("Screenshots");
    ensure_dir(&dir)?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Get current timestamp in milliseconds
pub fn get_timestamp() -> AppResult<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to get timestamp: {}", e))
        .map(|d| d.as_millis() as u64)
}

/// Ensure a directory exists, creating it if necessary
pub fn ensure_dir(path: &PathBuf) -> AppResult<()> {
    fs::create_dir_all(path).map_err(|e| format!("Failed to create directory: {}", e))
}

/// Generate a unique filename with a prefix and timestamp
pub fn generate_filename(prefix: &str, extension: &str) -> AppResult<String> {
    let timestamp = get_timestamp()?;
    Ok(format!("{}_{}.{}", prefix, timestamp, extension))
}

/// Generate a unique filename with prefix, id, and timestamp
pub fn generate_filename_with_id(prefix: &str, id: u32, extension: &str) -> AppResult<String> {
    let timestamp = get_timestamp()?;
    Ok(format!("{}_{}_{}.{}", prefix, id, timestamp, extension))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_timestamp_returns_valid_value() {
        let result = get_timestamp();
        assert!(result.is_ok());

        let timestamp = result.unwrap();
        assert!(timestamp > 0);
    }

    #[test]
    fn test_generate_filename_format() {
        let result = generate_filename("screenshot", "png");
        assert!(result.is_ok());

        let filename = result.unwrap();
        assert!(filename.starts_with("screenshot_"));
        assert!(filename.ends_with(".png"));
    }

    #[test]
    fn test_generate_filename_with_id_format() {
        let result = generate_filename_with_id("monitor", 1, "png");
        assert!(result.is_ok());

        let filename = result.unwrap();
        assert!(filename.starts_with("monitor_1_"));
        assert!(filename.ends_with(".png"));
    }

    #[test]
    fn test_generate_filename_uniqueness() {
        let filename1 = generate_filename("test", "png").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1));
        let filename2 = generate_filename("test", "png").unwrap();

        // Filenames should be different due to timestamp
        assert_ne!(filename1, filename2);
    }

    #[test]
    fn test_screenshotx_dir_is_hidden_cache_not_desktop() {
        let dir = get_screenshotx_dir().expect("screenshotx dir");
        // Source of truth is Firebase Storage; the local dir must be a hidden
        // app cache, never the user-visible Desktop.
        assert!(dir.ends_with("Screenshots"), "got: {dir}");
        assert!(!dir.contains("Desktop"), "must not live on Desktop: {dir}");
    }

    #[test]
    fn test_ensure_dir_creates_nested_directories() {
        let temp_dir = std::env::temp_dir();
        let test_path = temp_dir.join("screenshotx_test").join("nested").join("dir");

        let result = ensure_dir(&test_path);
        assert!(result.is_ok());
        assert!(test_path.exists());

        // Cleanup
        let _ = std::fs::remove_dir_all(temp_dir.join("screenshotx_test"));
    }
}
