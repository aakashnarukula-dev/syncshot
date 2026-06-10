package com.aakash.ssx.sync

import android.content.Context
import com.aakash.ssx.data.HubClient
import com.aakash.ssx.data.Prefs
import java.io.File

/** Single place that turns a "new hash" wake-event (from the WebSocket OR FCM)
 *  into a downloaded file + a "received" notification. Persistent dedup via the
 *  received/<hash>.png file keeps WS and FCM from double-notifying. */
object Receiver {
    fun receive(ctx: Context, hash: String?) {
        if (hash.isNullOrBlank()) return
        val prefs = Prefs(ctx)
        val base = prefs.baseUrl ?: return
        val dir = File(ctx.filesDir, "received").apply { mkdirs() }
        val f = File(dir, "$hash.png")
        if (f.exists()) return  // already received via the other channel
        try {
            val bytes = HubClient(base, prefs.token).downloadImage(hash)
            f.writeBytes(bytes)
            Notifications.notifyReceived(ctx, hash, f)
        } catch (_: Exception) {
        }
    }
}
