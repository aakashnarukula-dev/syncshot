package com.app.syncshot.data

import android.content.Context
import java.io.File
import java.util.Locale

/**
 * Canonical names for full-resolution image cache files.
 *
 * Screenshot bytes must keep their real extension: a JPEG called `.png` is
 * still decodable by some viewers, but Android shares it as `image/png` and
 * MediaStore indexes it incorrectly. Keep the format decision in one place so
 * capture, receive, share, save, and cleanup cannot drift apart.
 */
object ImageFiles {
    private val extensionByMime = mapOf(
        "image/png" to "png",
        "image/jpeg" to "jpg",
        "image/jpg" to "jpg",
        "image/gif" to "gif",
        "image/webp" to "webp",
        "image/heic" to "heic",
        "image/heif" to "heic",
    )

    private val mimeByExtension = mapOf(
        "png" to "image/png",
        "jpg" to "image/jpeg",
        "jpeg" to "image/jpeg",
        "gif" to "image/gif",
        "webp" to "image/webp",
        "heic" to "image/heic",
        "heif" to "image/heic",
    )

    private val knownExtensions = mimeByExtension.keys

    fun extensionForMime(mime: String?): String =
        extensionByMime[mime?.lowercase(Locale.ROOT)] ?: "png"

    fun mimeForFile(file: File, fallback: String = "image/png"): String =
        mimeByExtension[file.extension.lowercase(Locale.ROOT)] ?: fallback

    fun receivedFile(ctx: Context, sha: String, mime: String? = null): File =
        cacheFile(File(ctx.filesDir, "received"), sha, mime)

    fun sharedFile(ctx: Context, sha: String, mime: String? = null): File =
        cacheFile(File(ctx.cacheDir, "shared"), sha, mime)

    /** Find a cached copy, including files written by older versions that always
     * used `.png` regardless of their actual bytes. Prefer the canonical name. */
    fun findReceivedFile(ctx: Context, sha: String, mime: String? = null): File? =
        findCachedFile(File(ctx.filesDir, "received"), sha, mime)

    fun findSharedFile(ctx: Context, sha: String, mime: String? = null): File? =
        findCachedFile(File(ctx.cacheDir, "shared"), sha, mime)

    fun deleteCachedCopies(ctx: Context, sha: String) {
        listOf(File(ctx.filesDir, "received"), File(ctx.cacheDir, "shared")).forEach { dir ->
            knownExtensions.forEach { ext -> File(dir, "$sha.$ext").delete() }
        }
    }

    /** Move a legacy cache entry to its canonical extension when possible. Older
     * builds wrote every payload as `.png`; retaining that name makes providers
     * advertise JPEG/HEIC bytes with the wrong MIME type. */
    fun canonicalize(file: File, target: File): File {
        if (file == target) return file
        if (target.exists() && target.length() > 0L) return target
        if (file.renameTo(target)) return target
        return runCatching {
            file.copyTo(target, overwrite = true)
            file.delete()
            target
        }.getOrDefault(file)
    }

    private fun cacheFile(dir: File, sha: String, mime: String?): File {
        dir.mkdirs()
        return File(dir, "$sha.${extensionForMime(mime)}")
    }

    private fun findCachedFile(dir: File, sha: String, mime: String?): File? {
        val canonical = File(dir, "$sha.${extensionForMime(mime)}")
        if (canonical.exists() && canonical.length() > 0L) return canonical
        return knownExtensions
            .asSequence()
            .map { File(dir, "$sha.$it") }
            .firstOrNull { it.exists() && it.length() > 0L }
    }
}
