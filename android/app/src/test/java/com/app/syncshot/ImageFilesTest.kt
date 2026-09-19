package com.app.syncshot

import com.app.syncshot.data.ImageFiles
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import java.nio.file.Files

class ImageFilesTest {
    @Test
    fun maps_real_image_mime_types_to_safe_extensions() {
        assertEquals("png", ImageFiles.extensionForMime("image/png"))
        assertEquals("jpg", ImageFiles.extensionForMime("image/jpeg"))
        assertEquals("jpg", ImageFiles.extensionForMime("image/jpg"))
        assertEquals("heic", ImageFiles.extensionForMime("image/heif"))
        assertEquals("webp", ImageFiles.extensionForMime("image/webp"))
    }

    @Test
    fun derives_share_and_gallery_mime_from_the_actual_filename() {
        assertEquals("image/jpeg", ImageFiles.mimeForFile(File("captured.jpg")))
        assertEquals("image/heic", ImageFiles.mimeForFile(File("captured.heic")))
        assertEquals("image/png", ImageFiles.mimeForFile(File("captured.unknown")))
    }

    @Test
    fun migrates_a_legacy_png_name_to_the_real_extension() {
        val dir = Files.createTempDirectory("syncshot-image-files").toFile()
        val legacy = File(dir, "shot.png").apply { writeText("jpeg bytes") }
        val canonical = File(dir, "shot.jpg")

        assertEquals(canonical, ImageFiles.canonicalize(legacy, canonical))
        assertEquals("jpeg bytes", canonical.readText())
        assertEquals(false, legacy.exists())
        dir.deleteRecursively()
    }
}
