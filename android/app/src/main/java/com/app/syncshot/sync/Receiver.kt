package com.app.syncshot.sync

import android.content.Context
import com.app.syncshot.data.ImageFiles
import com.app.syncshot.data.FirebaseRepo
import com.app.syncshot.data.ScreenshotDoc
import java.io.File

/** Turns a full-resolution screenshot doc from another device into a local file +
 *  a notify-to-copy notification. A content-addressed received/<sha>.<ext> file
 *  is the persistent dedupe key, with the extension matching its real bytes. */
object Receiver {
    fun receivedFile(ctx: Context, sha: String, mime: String? = null): File =
        ImageFiles.receivedFile(ctx, sha, mime)

    /**
     * Download and notify for one newly-arrived screenshot.
     *
     * The caller advances its notification cursor only after this returns true.
     * Returning success rather than swallowing a failed download is important:
     * a transient network error must be retryable from the next Firestore
     * snapshot, not silently turn into a permanently missed screenshot.
     */
    suspend fun receive(ctx: Context, doc: ScreenshotDoc): Boolean {
        val path = doc.fullPath ?: return false
        val f = receivedFile(ctx, doc.sha256, doc.mime)
        if (ImageFiles.findReceivedFile(ctx, doc.sha256, doc.mime) != null) return true
        if (f.exists()) f.delete()
        return runCatching {
            val bytes = FirebaseRepo.downloadFull(path)
            // Never expose a partially-written image as a completed receive.
            val tmp = File(f.parentFile, "${f.name}.download")
            tmp.writeBytes(bytes)
            if (f.exists()) f.delete()
            if (!tmp.renameTo(f)) {
                tmp.copyTo(f, overwrite = true)
                tmp.delete()
            }
            Notifications.notifyReceived(ctx, doc.sha256, f)
            true
        }.getOrDefault(false)
    }
}
