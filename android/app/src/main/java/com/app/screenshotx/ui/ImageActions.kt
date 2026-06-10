package com.app.screenshotx.ui

import android.content.ClipData
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.FileProvider
import com.app.screenshotx.data.FirebaseRepo
import com.app.screenshotx.sync.Receiver
import java.io.File

/** Image side-effects shared by the viewer and notifications. Blocking download;
 *  call ensureFile off the main thread. */
object ImageActions {

    /** A real on-disk file for the image: the received copy if present, else the
     *  full.png downloaded from Storage and cached by sha256. */
    suspend fun ensureFile(ctx: Context, sha: String, fullPath: String): File {
        val recv = Receiver.receivedFile(ctx, sha)
        if (recv.exists()) return recv
        val dir = File(ctx.cacheDir, "shared").apply { mkdirs() }
        val out = File(dir, "$sha.png")
        if (!out.exists() || out.length() == 0L) {
            out.writeBytes(FirebaseRepo.downloadFull(fullPath))
        }
        return out
    }

    fun share(ctx: Context, file: File) {
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "image/png"
            putExtra(Intent.EXTRA_STREAM, uri)
            clipData = ClipData.newUri(ctx.contentResolver, file.name, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        ctx.startActivity(
            Intent.createChooser(send, "Share screenshot").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }

    fun saveToGallery(ctx: Context, file: File): Boolean {
        val bytes = file.readBytes()
        val fname = if (file.name.endsWith(".png", true)) file.name else "${file.name}.png"
        val resolver = ctx.contentResolver
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, fname)
                put(MediaStore.Images.Media.MIME_TYPE, "image/png")
                put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/ScreenshotX")
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
            File(pics, "ScreenshotX").apply { mkdirs() }
                .let { dir -> File(dir, fname).writeBytes(bytes) }
            true
        }
    }
}
