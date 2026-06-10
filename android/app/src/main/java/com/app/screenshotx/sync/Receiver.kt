package com.app.screenshotx.sync

import android.content.Context
import com.app.screenshotx.data.FirebaseRepo
import com.app.screenshotx.data.ScreenshotDoc
import java.io.File

/** Turns a full-resolution screenshot doc from another device into a local file +
 *  a notify-to-copy notification. The received/<sha>.png file is the persistent
 *  dedupe key so a shot is only ever notified once. */
object Receiver {
    fun receivedFile(ctx: Context, sha: String): File {
        val dir = File(ctx.filesDir, "received").apply { mkdirs() }
        return File(dir, "$sha.png")
    }

    suspend fun receive(ctx: Context, doc: ScreenshotDoc) {
        val path = doc.fullPath ?: return
        val f = receivedFile(ctx, doc.sha256)
        if (f.exists()) return
        runCatching {
            val bytes = FirebaseRepo.downloadFull(path)
            f.writeBytes(bytes)
            Notifications.notifyReceived(ctx, doc.sha256, f)
        }
    }
}
