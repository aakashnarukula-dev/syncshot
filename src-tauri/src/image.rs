//! Image processing module

use base64::{engine::general_purpose, Engine as _};
use image::DynamicImage;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use crate::utils::{ensure_dir, generate_filename, AppResult};

/// A small set of raster image formats we sniff from MAGIC BYTES so a synced
/// file is saved with the RIGHT extension and placed on the pasteboard with the
/// RIGHT UTI — never trusting the uploader's label. Many phones (e.g. Samsung)
/// upload JPEG bytes tagged `image/png`; written as `.png` they get no Finder
/// thumbnail and paste as mislabeled data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageKind {
    Png,
    Jpeg,
    Gif,
    Webp,
    Heic,
}

impl ImageKind {
    /// File extension (no dot) for this format.
    pub fn extension(self) -> &'static str {
        match self {
            ImageKind::Png => "png",
            ImageKind::Jpeg => "jpg",
            ImageKind::Gif => "gif",
            ImageKind::Webp => "webp",
            ImageKind::Heic => "heic",
        }
    }

    /// macOS pasteboard UTI for this format (so a paste carries the correct type).
    pub fn pasteboard_uti(self) -> &'static str {
        match self {
            ImageKind::Png => "public.png",
            ImageKind::Jpeg => "public.jpeg",
            ImageKind::Gif => "com.compuserve.gif",
            ImageKind::Webp => "org.webmproject.webp",
            ImageKind::Heic => "public.heic",
        }
    }
}

/// Detect a raster image format from its leading magic bytes. Returns None for
/// anything unrecognized (the caller keeps its default).
pub fn detect_image_kind(bytes: &[u8]) -> Option<ImageKind> {
    // JPEG: FF D8 FF
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return Some(ImageKind::Jpeg);
    }
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if bytes.len() >= 8 && &bytes[..8] == b"\x89PNG\r\n\x1a\n" {
        return Some(ImageKind::Png);
    }
    // GIF: "GIF87a" or "GIF89a"
    if bytes.len() >= 6 && (&bytes[..6] == b"GIF87a" || &bytes[..6] == b"GIF89a") {
        return Some(ImageKind::Gif);
    }
    // WEBP: RIFF....WEBP
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(ImageKind::Webp);
    }
    // HEIC/HEIF: ....ftyp<brand> with a known HEIF brand
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        let brand = &bytes[8..12];
        if brand == b"heic"
            || brand == b"heix"
            || brand == b"hevc"
            || brand == b"heim"
            || brand == b"heis"
            || brand == b"hevm"
            || brand == b"hevs"
            || brand == b"mif1"
        {
            return Some(ImageKind::Heic);
        }
    }
    None
}

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

/// Decode a `data:image/png;base64,` data URL into raw PNG bytes.
fn decode_base64_png(image_data: &str) -> AppResult<Vec<u8>> {
    let base64_data = image_data
        .strip_prefix("data:image/png;base64,")
        .ok_or("Invalid image data format: expected data:image/png;base64, prefix")?;

    general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| format!("Failed to decode base64: {}", e))
}

/// Save raw image bytes to a directory with a generated filename
pub fn save_image_bytes(image_bytes: &[u8], save_dir: &str, prefix: &str) -> AppResult<String> {
    let dest_path = PathBuf::from(save_dir);
    ensure_dir(&dest_path)?;

    let filename = generate_filename(prefix, "png")?;
    let file_path = dest_path.join(&filename);

    fs::write(&file_path, image_bytes).map_err(|e| format!("Failed to save image: {}", e))?;

    Ok(file_path.to_string_lossy().into_owned())
}

/// Save raw image bytes to an exact file path (overwriting it)
pub fn save_image_bytes_to_path(image_bytes: &[u8], file_path: &str) -> AppResult<String> {
    let path = PathBuf::from(file_path);
    if let Some(parent) = path.parent() {
        ensure_dir(&PathBuf::from(parent))?;
    }

    fs::write(&path, image_bytes).map_err(|e| format!("Failed to save image: {}", e))?;

    Ok(path.to_string_lossy().into_owned())
}

/// Save base64-encoded image data to a file
pub fn save_base64_image(image_data: &str, save_dir: &str, prefix: &str) -> AppResult<String> {
    save_image_bytes(&decode_base64_png(image_data)?, save_dir, prefix)
}

/// Save base64-encoded image data to an exact file path (overwriting it)
pub fn save_base64_image_to_path(image_data: &str, file_path: &str) -> AppResult<String> {
    save_image_bytes_to_path(&decode_base64_png(image_data)?, file_path)
}

/// Sequence for unique temp filenames so concurrent thumbnail generations of
/// the same source never write to the same file.
static THUMB_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Cap on SIMULTANEOUS thumbnail generations. The macOS CGImageSource path
/// decodes straight to thumbnail size (memory-light), so the gate is sized to
/// max(2, cores/2) — enough parallelism to paint a cold rail fast, while
/// leaving cores for the webview and capture pipeline. (The old cap of 3
/// guarded full-res `image`-crate decodes at ~60–130MB of bitmap each; that
/// path is now only the non-macOS/error fallback.) Cache hits never take a slot.
fn max_concurrent_thumb_decodes() -> u32 {
    static CAP: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    *CAP.get_or_init(|| {
        let cores = std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(4);
        (cores / 2).max(2)
    })
}

static THUMB_DECODE_SLOTS: std::sync::Mutex<u32> = std::sync::Mutex::new(0);
static THUMB_DECODE_CVAR: std::sync::Condvar = std::sync::Condvar::new();

/// RAII permit for one thumbnail decode; blocks until a slot frees up.
/// Blocking is fine here — callers already run on the blocking thread pool.
struct ThumbDecodeSlot;

impl ThumbDecodeSlot {
    fn acquire() -> Self {
        let mut in_flight = THUMB_DECODE_SLOTS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while *in_flight >= max_concurrent_thumb_decodes() {
            in_flight = THUMB_DECODE_CVAR
                .wait(in_flight)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        *in_flight += 1;
        ThumbDecodeSlot
    }
}

impl Drop for ThumbDecodeSlot {
    fn drop(&mut self) {
        let mut in_flight = THUMB_DECODE_SLOTS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *in_flight = in_flight.saturating_sub(1);
        drop(in_flight);
        THUMB_DECODE_CVAR.notify_one();
    }
}

/// Count of INTERACTIVE thumbnail requests currently queued or decoding
/// (frontend-driven, via the `get_screenshot_thumbnail*` commands). The launch
/// backfill polls this to stay out of the way: it pauses whenever the user is
/// actually waiting on a thumbnail.
static INTERACTIVE_THUMBS_PENDING: AtomicU32 = AtomicU32::new(0);

struct InteractiveThumbGuard;

impl InteractiveThumbGuard {
    fn new() -> Self {
        INTERACTIVE_THUMBS_PENDING.fetch_add(1, Ordering::SeqCst);
        InteractiveThumbGuard
    }
}

impl Drop for InteractiveThumbGuard {
    fn drop(&mut self) {
        INTERACTIVE_THUMBS_PENDING.fetch_sub(1, Ordering::SeqCst);
    }
}

fn interactive_thumbs_pending() -> bool {
    INTERACTIVE_THUMBS_PENDING.load(Ordering::SeqCst) > 0
}

/// Cache keys currently being GENERATED. A burst of tiles requesting the same
/// fresh file used to fire up to `max_concurrent_thumb_decodes()` identical
/// full decodes; now the first request generates while the rest wait on the
/// key and return the fresh cache entry.
static THUMB_INFLIGHT_KEYS: std::sync::Mutex<Vec<u64>> = std::sync::Mutex::new(Vec::new());
static THUMB_INFLIGHT_CVAR: std::sync::Condvar = std::sync::Condvar::new();

/// RAII marker that `key` is being generated; `acquire` blocks while another
/// thread holds the same key. Distinct keys never wait on each other here
/// (overall parallelism is bounded separately by ThumbDecodeSlot).
struct ThumbInflightGuard {
    key: u64,
}

impl ThumbInflightGuard {
    fn acquire(key: u64) -> Self {
        let mut keys = THUMB_INFLIGHT_KEYS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while keys.contains(&key) {
            keys = THUMB_INFLIGHT_CVAR
                .wait(keys)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        keys.push(key);
        ThumbInflightGuard { key }
    }
}

impl Drop for ThumbInflightGuard {
    fn drop(&mut self) {
        let mut keys = THUMB_INFLIGHT_KEYS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(i) = keys.iter().position(|k| *k == self.key) {
            keys.swap_remove(i);
        }
        drop(keys);
        THUMB_INFLIGHT_CVAR.notify_all();
    }
}

/// Where cached thumbnails live: a PERSISTENT cache dir (~/Library/Caches on
/// macOS), not the temp dir. macOS purges TMPDIR periodically, and every purge
/// meant the next column open regenerated the whole library's thumbnails — a
/// recurring cold-cache decode storm. Falls back to the temp dir only when no
/// cache dir can be resolved.
fn thumbnail_cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("com.aakashnarukula.syncshot")
        .join("thumbnails")
}

/// Compute the cache path (and its raw key) for `source_path`'s thumbnail.
/// The key covers the source path, its mtime and size, so an edited/replaced
/// file regenerates while an unchanged one reuses the cached encode. Errors
/// if the source can't be stat'd (missing file).
fn thumb_cache_path(source_path: &str, max_px: u32) -> AppResult<(PathBuf, u64)> {
    let meta =
        fs::metadata(source_path).map_err(|e| format!("Failed to stat screenshot: {}", e))?;
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

    let cache_dir = thumbnail_cache_dir();
    ensure_dir(&cache_dir)?;
    Ok((cache_dir.join(format!("thumb-{:016x}.png", key)), key))
}

/// Return the path to a cached, downscaled thumbnail of the screenshot at
/// `source_path` (longest side ≈ `max_px`), generating it if missing.
/// INTERACTIVE entry point (the launch backfill pauses while any of these are
/// pending). Concurrent calls are safe: each generation writes to a unique
/// temp file and atomically renames it into place, and same-file bursts
/// decode exactly once (see ThumbInflightGuard).
pub fn screenshot_thumbnail(source_path: &str, max_px: u32) -> AppResult<String> {
    let _interactive = InteractiveThumbGuard::new();
    thumbnail_impl(source_path, max_px)
}

fn thumbnail_impl(source_path: &str, max_px: u32) -> AppResult<String> {
    let (thumb_path, key) = thumb_cache_path(source_path, max_px)?;
    if thumb_path.exists() {
        return Ok(thumb_path.to_string_lossy().into_owned());
    }

    // Serialize same-key generations, then re-check the cache: if another
    // thread was already generating this exact thumbnail, it's on disk now.
    let _inflight = ThumbInflightGuard::acquire(key);
    if thumb_path.exists() {
        return Ok(thumb_path.to_string_lossy().into_owned());
    }

    // Bound overall decode parallelism (see max_concurrent_thumb_decodes).
    let _slot = ThumbDecodeSlot::acquire();
    generate_thumbnail(Path::new(source_path), &thumb_path, key, max_px)?;
    Ok(thumb_path.to_string_lossy().into_owned())
}

/// Decode `src` to a ≤`max_px` PNG at `thumb_path` (via unique temp file +
/// atomic rename). macOS uses CGImageSource thumbnailing — decodes straight to
/// target size, ~10x faster and memory-light versus a full `image`-crate
/// decode of a retina PNG — falling back to the portable path on any failure
/// (e.g. a format ImageIO can't read). Non-macOS always uses the portable path.
fn generate_thumbnail(src: &Path, thumb_path: &Path, key: u64, max_px: u32) -> AppResult<()> {
    let cache_dir = thumb_path
        .parent()
        .ok_or_else(|| "Thumbnail path has no parent directory".to_string())?;
    let max_px = max_px.max(1);
    let seq = THUMB_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_path = cache_dir.join(format!(
        "thumb-{:016x}.{}-{}.tmp.png",
        key,
        std::process::id(),
        seq
    ));

    #[cfg(target_os = "macos")]
    {
        match cg_thumb::write_thumbnail_png(src, &tmp_path, max_px) {
            Ok(()) => return finalize_thumb(&tmp_path, thumb_path),
            Err(e) => {
                let _ = fs::remove_file(&tmp_path);
                eprintln!(
                    "[thumb] CGImageSource failed for {} ({}); using image-crate fallback",
                    src.display(),
                    e
                );
            }
        }
    }

    let img = image::open(src).map_err(|e| format!("Failed to open screenshot: {}", e))?;
    let thumb = if img.width() <= max_px && img.height() <= max_px {
        img
    } else {
        img.thumbnail(max_px, max_px)
    };
    thumb
        .save_with_format(&tmp_path, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to save thumbnail: {}", e))?;
    finalize_thumb(&tmp_path, thumb_path)
}

fn finalize_thumb(tmp_path: &Path, thumb_path: &Path) -> AppResult<()> {
    fs::rename(tmp_path, thumb_path).map_err(|e| {
        let _ = fs::remove_file(tmp_path);
        format!("Failed to finalize thumbnail: {}", e)
    })
}

/// The `max_px` the launch-time thumbnail backfill generates at. MUST match
/// `THUMB_MAX_PX` in `src/components/ScreenshotThumbnail.tsx` — a different
/// value keys a different cache entry and the rail would still cold-decode.
pub const BACKFILL_THUMB_MAX_PX: u32 = 512;

/// One LOW-PRIORITY pass over the image files in `dir`, generating any
/// missing/stale thumbnail cache entries. Strictly serial (one decode at a
/// time), sleeps between files, and pauses whenever an interactive thumbnail
/// request is pending — interactive work always wins; the backfill is starved
/// by design. Returns (generated, skipped, failed) counts.
pub fn backfill_thumbnails(dir: &str, max_px: u32) -> (usize, usize, usize) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return (0, 0, 0),
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_lowercase())
                .unwrap_or_default();
            matches!(
                ext.as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "heic"
            ) && p.is_file()
        })
        .collect();
    files.sort();

    let (mut generated, mut skipped, mut failed) = (0, 0, 0);
    for file in files {
        while interactive_thumbs_pending() {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        let path_str = file.to_string_lossy().into_owned();
        match thumb_cache_path(&path_str, max_px) {
            Ok((thumb_path, _)) if thumb_path.exists() => {
                skipped += 1;
                continue;
            }
            Ok(_) => {}
            Err(_) => {
                // File vanished between the listing and the stat.
                failed += 1;
                continue;
            }
        }
        match thumbnail_impl(&path_str, max_px) {
            Ok(_) => generated += 1,
            Err(e) => {
                failed += 1;
                eprintln!("[thumb-backfill] {} failed: {}", path_str, e);
            }
        }
        // Yield between files so the pass never monopolizes I/O or a core.
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    (generated, skipped, failed)
}

/// macOS fast thumbnailing via ImageIO's CGImageSource: decodes STRAIGHT to a
/// bounded-size thumbnail (kCGImageSourceCreateThumbnailFromImageAlways +
/// kCGImageSourceThumbnailMaxPixelSize) instead of materializing the full-res
/// bitmap, using the OS's hardware-accelerated decoders. Raw C FFI — same
/// pattern as commands.rs's cg_cursor — to avoid pulling in binding crates.
#[cfg(target_os = "macos")]
mod cg_thumb {
    use std::ffi::c_void;
    use std::os::raw::{c_char, c_long};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    type Boolean = u8;
    type CFIndex = c_long;
    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type CFURLRef = *const c_void;
    type CFNumberRef = *const c_void;
    type CFDictionaryRef = *const c_void;
    type CFAllocatorRef = *const c_void;
    type CGImageRef = *const c_void;
    type CGImageSourceRef = *const c_void;
    type CGImageDestinationRef = *const c_void;

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const K_CF_NUMBER_SINT32_TYPE: CFIndex = 3;

    /// Opaque callback tables — only their ADDRESSES are passed to
    /// CFDictionaryCreate.
    #[repr(C)]
    struct CFDictionaryCallBacks {
        _opaque: [u8; 0],
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFTypeDictionaryKeyCallBacks: CFDictionaryCallBacks;
        static kCFTypeDictionaryValueCallBacks: CFDictionaryCallBacks;
        static kCFBooleanTrue: CFTypeRef;
        fn CFStringCreateWithCString(
            alloc: CFAllocatorRef,
            s: *const c_char,
            encoding: u32,
        ) -> CFStringRef;
        fn CFURLCreateFromFileSystemRepresentation(
            alloc: CFAllocatorRef,
            buffer: *const u8,
            buf_len: CFIndex,
            is_directory: Boolean,
        ) -> CFURLRef;
        fn CFNumberCreate(
            alloc: CFAllocatorRef,
            number_type: CFIndex,
            value_ptr: *const c_void,
        ) -> CFNumberRef;
        fn CFDictionaryCreate(
            alloc: CFAllocatorRef,
            keys: *const CFTypeRef,
            values: *const CFTypeRef,
            num_values: CFIndex,
            key_callbacks: *const CFDictionaryCallBacks,
            value_callbacks: *const CFDictionaryCallBacks,
        ) -> CFDictionaryRef;
        fn CFRelease(cf: CFTypeRef);
    }

    #[link(name = "ImageIO", kind = "framework")]
    extern "C" {
        static kCGImageSourceCreateThumbnailFromImageAlways: CFStringRef;
        static kCGImageSourceCreateThumbnailWithTransform: CFStringRef;
        static kCGImageSourceThumbnailMaxPixelSize: CFStringRef;
        fn CGImageSourceCreateWithURL(
            url: CFURLRef,
            options: CFDictionaryRef,
        ) -> CGImageSourceRef;
        fn CGImageSourceCreateThumbnailAtIndex(
            src: CGImageSourceRef,
            index: usize,
            options: CFDictionaryRef,
        ) -> CGImageRef;
        fn CGImageDestinationCreateWithURL(
            url: CFURLRef,
            ty: CFStringRef,
            count: usize,
            options: CFDictionaryRef,
        ) -> CGImageDestinationRef;
        fn CGImageDestinationAddImage(
            dest: CGImageDestinationRef,
            image: CGImageRef,
            properties: CFDictionaryRef,
        );
        fn CGImageDestinationFinalize(dest: CGImageDestinationRef) -> Boolean;
    }

    /// Owned CF object released on drop. Never wrap the extern constants.
    struct CF(CFTypeRef);

    impl CF {
        fn new(r: CFTypeRef, what: &str) -> Result<Self, String> {
            if r.is_null() {
                Err(format!("{} returned null", what))
            } else {
                Ok(CF(r))
            }
        }
    }

    impl Drop for CF {
        fn drop(&mut self) {
            unsafe { CFRelease(self.0) }
        }
    }

    fn file_url(path: &Path, what: &str) -> Result<CF, String> {
        let bytes = path.as_os_str().as_bytes();
        let url = unsafe {
            CFURLCreateFromFileSystemRepresentation(
                std::ptr::null(),
                bytes.as_ptr(),
                bytes.len() as CFIndex,
                0,
            )
        };
        CF::new(url, what)
    }

    /// Decode `src` straight to a ≤`max_px` thumbnail (EXIF orientation
    /// applied, never upscaled) and write it as PNG to `dest`.
    pub fn write_thumbnail_png(src: &Path, dest: &Path, max_px: u32) -> Result<(), String> {
        unsafe {
            let src_url = file_url(src, "CFURL(src)")?;
            let image_source = CF::new(
                CGImageSourceCreateWithURL(src_url.0, std::ptr::null()),
                "CGImageSourceCreateWithURL",
            )?;

            let max_px = max_px.min(i32::MAX as u32) as i32;
            let max_px_num = CF::new(
                CFNumberCreate(
                    std::ptr::null(),
                    K_CF_NUMBER_SINT32_TYPE,
                    &max_px as *const i32 as *const c_void,
                ),
                "CFNumberCreate",
            )?;

            let keys: [CFTypeRef; 3] = [
                kCGImageSourceCreateThumbnailFromImageAlways,
                kCGImageSourceCreateThumbnailWithTransform,
                kCGImageSourceThumbnailMaxPixelSize,
            ];
            let values: [CFTypeRef; 3] = [kCFBooleanTrue, kCFBooleanTrue, max_px_num.0];
            let options = CF::new(
                CFDictionaryCreate(
                    std::ptr::null(),
                    keys.as_ptr(),
                    values.as_ptr(),
                    keys.len() as CFIndex,
                    &kCFTypeDictionaryKeyCallBacks,
                    &kCFTypeDictionaryValueCallBacks,
                ),
                "CFDictionaryCreate",
            )?;

            let thumb = CF::new(
                CGImageSourceCreateThumbnailAtIndex(image_source.0, 0, options.0),
                "CGImageSourceCreateThumbnailAtIndex",
            )?;

            let png_type = CF::new(
                CFStringCreateWithCString(
                    std::ptr::null(),
                    b"public.png\0".as_ptr() as *const c_char,
                    K_CF_STRING_ENCODING_UTF8,
                ),
                "CFString(public.png)",
            )?;
            let dest_url = file_url(dest, "CFURL(dest)")?;
            let destination = CF::new(
                CGImageDestinationCreateWithURL(dest_url.0, png_type.0, 1, std::ptr::null()),
                "CGImageDestinationCreateWithURL",
            )?;
            CGImageDestinationAddImage(destination.0, thumb.0, std::ptr::null());
            if CGImageDestinationFinalize(destination.0) == 0 {
                return Err("CGImageDestinationFinalize failed".to_string());
            }
        }
        Ok(())
    }
}

/// Like `screenshot_thumbnail`, but returns the thumbnail's PNG BYTES rather than
/// its on-disk path. The frontend builds a same-origin `blob:` URL from these
/// bytes instead of an `asset://` URL: in the RELEASE build the webview origin is
/// `http://localhost:38217`, which CANNOT CORS-load the `asset://` protocol, so a
/// path-based `<img src>` never paints (the bug this fixes). A `blob:` URL is
/// same-origin and renders regardless of webview origin (dev `tauri://` AND
/// release `http://localhost`). Reuses the on-disk thumbnail cache, so repeated
/// calls for the same file still avoid re-decoding.
pub fn screenshot_thumbnail_bytes(source_path: &str, max_px: u32) -> AppResult<Vec<u8>> {
    let thumb_path = screenshot_thumbnail(source_path, max_px)?;
    fs::read(&thumb_path).map_err(|e| format!("Failed to read thumbnail bytes: {}", e))
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

    mod detect_image_kind {
        use super::*;

        #[test]
        fn detects_jpeg_from_ffd8ff() {
            let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
            assert_eq!(detect_image_kind(&jpeg), Some(ImageKind::Jpeg));
            assert_eq!(ImageKind::Jpeg.extension(), "jpg");
            assert_eq!(ImageKind::Jpeg.pasteboard_uti(), "public.jpeg");
        }

        #[test]
        fn detects_png_signature() {
            let png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0d";
            assert_eq!(detect_image_kind(png), Some(ImageKind::Png));
            assert_eq!(ImageKind::Png.extension(), "png");
            assert_eq!(ImageKind::Png.pasteboard_uti(), "public.png");
        }

        #[test]
        fn detects_gif() {
            assert_eq!(detect_image_kind(b"GIF89a....."), Some(ImageKind::Gif));
            assert_eq!(detect_image_kind(b"GIF87a....."), Some(ImageKind::Gif));
        }

        #[test]
        fn detects_webp_riff_container() {
            let webp = b"RIFF\x24\x00\x00\x00WEBPVP8 ";
            assert_eq!(detect_image_kind(webp), Some(ImageKind::Webp));
        }

        #[test]
        fn detects_heic_by_ftyp_brand() {
            let heic = b"\x00\x00\x00\x18ftypheic";
            assert_eq!(detect_image_kind(heic), Some(ImageKind::Heic));
            let mif1 = b"\x00\x00\x00\x18ftypmif1";
            assert_eq!(detect_image_kind(mif1), Some(ImageKind::Heic));
        }

        #[test]
        fn returns_none_for_unknown_or_short() {
            assert_eq!(detect_image_kind(b"not an image"), None);
            assert_eq!(detect_image_kind(&[0xFF]), None);
            assert_eq!(detect_image_kind(b""), None);
            // A different ftyp brand (e.g. mp4) is not HEIF.
            assert_eq!(detect_image_kind(b"\x00\x00\x00\x18ftypmp42"), None);
        }
    }

    mod thumbnails {
        use super::*;
        use std::sync::atomic::{AtomicU32, Ordering};
        use std::sync::Arc;

        #[test]
        fn cache_dir_is_persistent_not_tmp() {
            let dir = thumbnail_cache_dir();
            let s = dir.to_string_lossy();
            assert!(
                s.ends_with("com.aakashnarukula.syncshot/thumbnails"),
                "got: {s}"
            );
            // On macOS this must resolve to ~/Library/Caches, never the
            // periodically-purged TMPDIR (purge = recurring decode storm).
            #[cfg(target_os = "macos")]
            assert!(s.contains("/Library/Caches/"), "got: {s}");
        }

        #[test]
        fn decode_slots_bound_concurrency() {
            let cap = max_concurrent_thumb_decodes();
            assert!(cap >= 2, "cap must allow at least 2 decodes, got {cap}");
            let live = Arc::new(AtomicU32::new(0));
            let peak = Arc::new(AtomicU32::new(0));
            let handles: Vec<_> = (0..32)
                .map(|_| {
                    let live = live.clone();
                    let peak = peak.clone();
                    std::thread::spawn(move || {
                        let _slot = ThumbDecodeSlot::acquire();
                        let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(now, Ordering::SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(10));
                        live.fetch_sub(1, Ordering::SeqCst);
                    })
                })
                .collect();
            for h in handles {
                h.join().unwrap();
            }
            assert!(
                peak.load(Ordering::SeqCst) <= cap,
                "peak {} exceeded cap {}",
                peak.load(Ordering::SeqCst),
                cap
            );
        }

        #[test]
        fn inflight_guard_serializes_same_key() {
            let live = Arc::new(AtomicU32::new(0));
            let peak = Arc::new(AtomicU32::new(0));
            let handles: Vec<_> = (0..8)
                .map(|_| {
                    let live = live.clone();
                    let peak = peak.clone();
                    std::thread::spawn(move || {
                        let _guard = ThumbInflightGuard::acquire(0xD00D_u64);
                        let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(now, Ordering::SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(5));
                        live.fetch_sub(1, Ordering::SeqCst);
                    })
                })
                .collect();
            for h in handles {
                h.join().unwrap();
            }
            assert_eq!(
                peak.load(Ordering::SeqCst),
                1,
                "same-key generations must never overlap"
            );
        }

        #[test]
        fn inflight_guard_distinct_keys_do_not_block() {
            // Holding key A must not block an acquire of key B: if it did,
            // this test would deadlock (joined thread waits forever).
            let _a = ThumbInflightGuard::acquire(0xAAA0_0001);
            let t = std::thread::spawn(|| {
                let _b = ThumbInflightGuard::acquire(0xBBB0_0002);
            });
            t.join().unwrap();
        }

        #[test]
        fn cg_unsupported_format_falls_back_to_image_crate() {
            // PPM: written by the image crate, unreadable by macOS ImageIO —
            // exercises the CGImageSource-error → portable-decode fallback.
            // On non-macOS this is simply the portable path.
            let dir = std::env::temp_dir().join(format!(
                "syncshot_thumb_fallback_test_{}",
                std::process::id()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let src = dir.join("src.ppm");
            let img = DynamicImage::new_rgb8(64, 48);
            img.save_with_format(&src, image::ImageFormat::Pnm)
                .expect("write ppm");
            let src_str = src.to_string_lossy().into_owned();

            let thumb_path = screenshot_thumbnail(&src_str, 32).expect("fallback thumbnail");
            let thumb = image::open(&thumb_path).expect("decodable thumb");
            assert!(thumb.width() <= 32 && thumb.height() <= 32);

            let _ = std::fs::remove_file(std::path::Path::new(&thumb_path));
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn backfill_generates_missing_and_skips_fresh() {
            let dir = std::env::temp_dir().join(format!(
                "syncshot_backfill_test_{}",
                std::process::id()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let a = dir.join("a.png");
            let b = dir.join("b.png");
            DynamicImage::new_rgba8(64, 48).save(&a).unwrap();
            DynamicImage::new_rgba8(48, 64).save(&b).unwrap();
            // Non-image files must be ignored entirely.
            std::fs::write(dir.join("notes.txt"), b"not an image").unwrap();

            // Pre-generate a's thumbnail: backfill must skip it, generate b's.
            let a_thumb = screenshot_thumbnail(&a.to_string_lossy(), 32).unwrap();

            let (generated, skipped, failed) =
                backfill_thumbnails(&dir.to_string_lossy(), 32);
            assert_eq!((generated, skipped, failed), (1, 1, 0));

            let b_thumb = thumb_cache_path(&b.to_string_lossy(), 32).unwrap().0;
            assert!(b_thumb.exists(), "backfill must generate b's thumbnail");

            // A second pass is a full skip.
            let (generated2, skipped2, failed2) =
                backfill_thumbnails(&dir.to_string_lossy(), 32);
            assert_eq!((generated2, skipped2, failed2), (0, 2, 0));

            let _ = std::fs::remove_file(std::path::Path::new(&a_thumb));
            let _ = std::fs::remove_file(&b_thumb);
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn thumbnail_bytes_downscale_and_cache() {
            // Source: a 64x48 PNG written to a temp file.
            let dir = std::env::temp_dir().join(format!(
                "syncshot_thumb_test_{}",
                std::process::id()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let src = dir.join("src.png");
            let img = DynamicImage::new_rgba8(64, 48);
            img.save(&src).unwrap();
            let src_str = src.to_string_lossy().into_owned();

            let bytes = screenshot_thumbnail_bytes(&src_str, 32).expect("thumbnail bytes");
            assert!(!bytes.is_empty());
            let thumb = image::load_from_memory(&bytes).expect("decodable png");
            assert!(thumb.width() <= 32 && thumb.height() <= 32);

            // Second call must serve the SAME cached file (path is key-stable).
            let p1 = screenshot_thumbnail(&src_str, 32).unwrap();
            let p2 = screenshot_thumbnail(&src_str, 32).unwrap();
            assert_eq!(p1, p2);
            assert!(std::path::Path::new(&p1).exists());

            let _ = std::fs::remove_file(std::path::Path::new(&p1));
            let _ = std::fs::remove_dir_all(&dir);
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
