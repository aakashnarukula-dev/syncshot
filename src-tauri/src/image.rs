//! Image processing module

use base64::{engine::general_purpose, Engine as _};
use image::DynamicImage;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::utils::{ensure_dir, generate_filename, AppResult};

/// Region coordinates for cropping
#[derive(Debug, Clone, Copy)]
pub struct CropRegion {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl CropRegion {
    /// Create a new crop region, clamping to image bounds
    pub fn clamped(
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        img_width: u32,
        img_height: u32,
    ) -> Self {
        let crop_x = x.min(img_width.saturating_sub(1));
        let crop_y = y.min(img_height.saturating_sub(1));
        let crop_width = width.min(img_width.saturating_sub(crop_x));
        let crop_height = height.min(img_height.saturating_sub(crop_y));

        Self {
            x: crop_x,
            y: crop_y,
            width: crop_width,
            height: crop_height,
        }
    }

    /// Check if the region is valid (non-zero dimensions)
    pub fn is_valid(&self) -> bool {
        self.width > 0 && self.height > 0
    }
}

/// Crop an image file and save to a new location
pub fn crop_image(source_path: &str, region: CropRegion, save_dir: &str) -> AppResult<String> {
    let img = image::open(source_path).map_err(|e| format!("Failed to open screenshot: {}", e))?;

    let img_width = img.width();
    let img_height = img.height();

    // Clamp region to image bounds
    let region = CropRegion::clamped(
        region.x,
        region.y,
        region.width,
        region.height,
        img_width,
        img_height,
    );

    if !region.is_valid() {
        return Err(format!(
            "Invalid crop region: x={}, y={}, w={}, h={} (image: {}x{})",
            region.x, region.y, region.width, region.height, img_width, img_height
        ));
    }

    let cropped = img.crop_imm(region.x, region.y, region.width, region.height);

    save_image(&cropped, save_dir, "region")
}

/// Save a DynamicImage to a directory with a generated filename
pub fn save_image(img: &DynamicImage, save_dir: &str, prefix: &str) -> AppResult<String> {
    let dest_path = PathBuf::from(save_dir);
    ensure_dir(&dest_path)?;

    let filename = generate_filename(prefix, "png")?;
    let file_path = dest_path.join(&filename);

    img.save(&file_path)
        .map_err(|e| format!("Failed to save image: {}", e))?;

    Ok(file_path.to_string_lossy().into_owned())
}

/// Save base64-encoded image data to a file
pub fn save_base64_image(image_data: &str, save_dir: &str, prefix: &str) -> AppResult<String> {
    let base64_data = image_data
        .strip_prefix("data:image/png;base64,")
        .ok_or("Invalid image data format: expected data:image/png;base64, prefix")?;

    let image_bytes = general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    let dest_path = PathBuf::from(save_dir);
    ensure_dir(&dest_path)?;

    let filename = generate_filename(prefix, "png")?;
    let file_path = dest_path.join(&filename);

    fs::write(&file_path, image_bytes).map_err(|e| format!("Failed to save image: {}", e))?;

    Ok(file_path.to_string_lossy().into_owned())
}

/// Save base64-encoded image data to an exact file path (overwriting it)
pub fn save_base64_image_to_path(image_data: &str, file_path: &str) -> AppResult<String> {
    let base64_data = image_data
        .strip_prefix("data:image/png;base64,")
        .ok_or("Invalid image data format: expected data:image/png;base64, prefix")?;

    let image_bytes = general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    let path = PathBuf::from(file_path);
    if let Some(parent) = path.parent() {
        ensure_dir(&PathBuf::from(parent))?;
    }

    fs::write(&path, image_bytes).map_err(|e| format!("Failed to save image: {}", e))?;

    Ok(path.to_string_lossy().into_owned())
}

/// Sequence for unique temp filenames so concurrent thumbnail generations of
/// the same source never write to the same file.
static THUMB_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Return the path to a cached, downscaled thumbnail of the screenshot at
/// `source_path` (longest side ≈ `max_px`). The cache key covers the source
/// path, its mtime and size, so an edited/replaced file regenerates while an
/// unchanged one reuses the cached encode. Concurrent calls are safe: each
/// writes to a unique temp file and atomically renames it into place.
pub fn screenshot_thumbnail(source_path: &str, max_px: u32) -> AppResult<String> {
    let src = PathBuf::from(source_path);
    let meta =
        fs::metadata(&src).map_err(|e| format!("Failed to stat screenshot: {}", e))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let mut hasher = DefaultHasher::new();
    source_path.hash(&mut hasher);
    mtime.hash(&mut hasher);
    meta.len().hash(&mut hasher);
    max_px.hash(&mut hasher);
    let key = hasher.finish();

    let cache_dir = std::env::temp_dir().join("screenshotx-thumbnails");
    ensure_dir(&cache_dir)?;
    let thumb_path = cache_dir.join(format!("thumb-{:016x}.png", key));
    if thumb_path.exists() {
        return Ok(thumb_path.to_string_lossy().into_owned());
    }

    let img = image::open(&src).map_err(|e| format!("Failed to open screenshot: {}", e))?;
    let max_px = max_px.max(1);
    let thumb = if img.width() <= max_px && img.height() <= max_px {
        img
    } else {
        img.thumbnail(max_px, max_px)
    };

    let seq = THUMB_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_path = cache_dir.join(format!(
        "thumb-{:016x}.{}-{}.tmp.png",
        key,
        std::process::id(),
        seq
    ));
    thumb
        .save_with_format(&tmp_path, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to save thumbnail: {}", e))?;
    fs::rename(&tmp_path, &thumb_path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("Failed to finalize thumbnail: {}", e)
    })?;

    Ok(thumb_path.to_string_lossy().into_owned())
}

/// Copy a screenshot file to a destination directory
pub fn copy_screenshot_to_dir(source_path: &str, save_dir: &str) -> AppResult<String> {
    let src_path = PathBuf::from(source_path);
    if !src_path.exists() {
        return Err(format!("Screenshot file not found: {}", source_path));
    }

    let dest_path = PathBuf::from(save_dir);
    ensure_dir(&dest_path)?;

    let filename = generate_filename("shot", "png")?;
    let file_path = dest_path.join(&filename);

    fs::copy(&src_path, &file_path).map_err(|e| format!("Failed to copy screenshot: {}", e))?;

    Ok(file_path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    mod crop_region {
        use super::*;

        #[test]
        fn test_crop_region_clamped_within_bounds() {
            let region = CropRegion::clamped(100, 100, 200, 200, 1920, 1080);

            assert_eq!(region.x, 100);
            assert_eq!(region.y, 100);
            assert_eq!(region.width, 200);
            assert_eq!(region.height, 200);
        }

        #[test]
        fn test_crop_region_clamped_exceeds_bounds() {
            // Region that exceeds image bounds
            let region = CropRegion::clamped(1800, 1000, 500, 500, 1920, 1080);

            assert_eq!(region.x, 1800);
            assert_eq!(region.y, 1000);
            assert_eq!(region.width, 120); // 1920 - 1800 = 120
            assert_eq!(region.height, 80); // 1080 - 1000 = 80
        }

        #[test]
        fn test_crop_region_clamped_x_y_exceed_bounds() {
            // X and Y exceed image dimensions
            let region = CropRegion::clamped(2000, 2000, 100, 100, 1920, 1080);

            assert_eq!(region.x, 1919); // Clamped to img_width - 1
            assert_eq!(region.y, 1079); // Clamped to img_height - 1
            assert_eq!(region.width, 1); // Only 1 pixel available
            assert_eq!(region.height, 1); // Only 1 pixel available
        }

        #[test]
        fn test_crop_region_is_valid() {
            let valid_region = CropRegion {
                x: 0,
                y: 0,
                width: 100,
                height: 100,
            };
            assert!(valid_region.is_valid());

            let invalid_region_zero_width = CropRegion {
                x: 0,
                y: 0,
                width: 0,
                height: 100,
            };
            assert!(!invalid_region_zero_width.is_valid());

            let invalid_region_zero_height = CropRegion {
                x: 0,
                y: 0,
                width: 100,
                height: 0,
            };
            assert!(!invalid_region_zero_height.is_valid());
        }

        #[test]
        fn test_crop_region_at_origin() {
            let region = CropRegion::clamped(0, 0, 100, 100, 1920, 1080);

            assert_eq!(region.x, 0);
            assert_eq!(region.y, 0);
            assert_eq!(region.width, 100);
            assert_eq!(region.height, 100);
            assert!(region.is_valid());
        }

        #[test]
        fn test_crop_region_full_image() {
            let region = CropRegion::clamped(0, 0, 1920, 1080, 1920, 1080);

            assert_eq!(region.x, 0);
            assert_eq!(region.y, 0);
            assert_eq!(region.width, 1920);
            assert_eq!(region.height, 1080);
            assert!(region.is_valid());
        }
    }

    mod base64_validation {
        #[test]
        fn test_base64_prefix_validation() {
            let valid_prefix = "data:image/png;base64,";
            let test_data = format!("{}iVBORw0KGgo=", valid_prefix);

            let result = test_data.strip_prefix("data:image/png;base64,");
            assert!(result.is_some());
            assert_eq!(result.unwrap(), "iVBORw0KGgo=");
        }

        #[test]
        fn test_base64_invalid_prefix() {
            let invalid_data = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

            let result = invalid_data.strip_prefix("data:image/png;base64,");
            assert!(result.is_none());
        }
    }
}
