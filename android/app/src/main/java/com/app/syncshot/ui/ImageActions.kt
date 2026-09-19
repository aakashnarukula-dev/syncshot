package com.app.syncshot.ui

import android.content.ClipData
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.FileProvider
import com.app.syncshot.data.FirebaseRepo
import com.app.syncshot.data.ImageFiles
import com.app.syncshot.data.db.AppDb
import com.app.syncshot.data.db.ScreenshotEntity
import java.io.File

/** Image side-effects shared by the viewer and notifications. Blocking download;
 *  call ensureFile off the main thread. */
object ImageActions {

    /** A real on-disk file for the image: the received copy if present, else the
     *  full-resolution Storage object cached with its true extension. */
    suspend fun ensureFile(ctx: Context, sha: String, fullPath: String, mime: String): File {
        ImageFiles.findReceivedFile(ctx, sha, mime)?.let {
            return ImageFiles.canonicalize(it, ImageFiles.receivedFile(ctx, sha, mime))
        }
        ImageFiles.findSharedFile(ctx, sha, mime)?.let {
            return ImageFiles.canonicalize(it, ImageFiles.sharedFile(ctx, sha, mime))
        }
        val out = ImageFiles.sharedFile(ctx, sha, mime)
        if (!out.exists() || out.length() == 0L) {
            out.writeBytes(FirebaseRepo.downloadFull(fullPath))
        }
        return out
    }

    fun share(ctx: Context, file: File) {
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = ImageFiles.mimeForFile(file)
            putExtra(Intent.EXTRA_STREAM, uri)
            clipData = ClipData.newUri(ctx.contentResolver, file.name, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        ctx.startActivity(
            Intent.createChooser(send, "Share screenshot").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }

    /** Delete a screenshot from everywhere: cloud doc + Storage blobs, the local
     *  Room row (so the grid drops it immediately), and any received/cached file
     *  copies. Cloud delete runs first so a failure leaves the local mirror intact
     *  (the tile stays, the caller can report failure). Once the doc is gone the
     *  Firestore listener won't re-add it on the next snapshot. Call off the main
     *  thread. */
    suspend fun deleteEverywhere(ctx: Context, item: ScreenshotEntity) {
        FirebaseRepo.deleteScreenshot(item.id, item.thumbPath, item.fullPath)
        AppDb.get(ctx).screenshots().deleteById(item.id)
        runCatching { ImageFiles.deleteCachedCopies(ctx, item.sha256) }
    }

    fun saveToGallery(ctx: Context, file: File): Boolean {
        val bytes = file.readBytes()
        val mime = ImageFiles.mimeForFile(file)
        val fname = file.name.ifBlank { "screenshot.${ImageFiles.extensionForMime(mime)}" }
        val resolver = ctx.contentResolver
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, fname)
                put(MediaStore.Images.Media.MIME_TYPE, mime)
                put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/SyncShot")
                put(MediaStore.Images.Media.IS_PENDING, 1)
            }
            val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                ?: return false
            resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: return false
            values.clear()
            values.put(MediaStore.Images.Media.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            true
        } else {
            @Suppress("DEPRECATION")
            val pics = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES)
            File(pics, "SyncShot").apply { mkdirs() }
                .let { dir -> File(dir, fname).writeBytes(bytes) }
            true
        }
    }
}
