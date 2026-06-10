package com.aakash.ssx.sync

import android.content.Context
import com.aakash.ssx.data.HubClient
import com.aakash.ssx.data.Prefs
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlin.concurrent.thread

/** Wakes the app on a data-only "new" push and routes it through Receiver,
 *  which dedups against the WebSocket path. No-ops cleanly if Firebase is
 *  not initialized (no google-services.json), in which case the app relies
 *  on the existing WebSocket receive path. */
class FcmService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        if (data["type"] == "new") {
            Receiver.receive(this, data["hash"])
        }
    }

    override fun onNewToken(token: String) {
        if (!Prefs(this).isPaired) return
        val prefs = Prefs(this)
        val base = prefs.baseUrl ?: return
        thread {
            try {
                HubClient(base, prefs.token).registerFcmToken(token)
            } catch (_: Exception) {
            }
        }
    }
}

/** Best-effort, fully guarded FCM helpers. Every Firebase entry point is gated
 *  on FirebaseApp.getApps(...) being non-empty so the app runs fine when FCM
 *  is absent. */
object Fcm {
    fun isAvailable(ctx: Context): Boolean =
        try {
            FirebaseApp.getApps(ctx).isNotEmpty()
        } catch (_: Throwable) {
            false
        }

    /** Fetch the current token (if Firebase is present) and register it with the hub. */
    fun registerCurrentToken(ctx: Context) {
        if (!isAvailable(ctx)) return
        val prefs = Prefs(ctx)
        val base = prefs.baseUrl ?: return
        try {
            FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
                if (token.isNullOrBlank()) return@addOnSuccessListener
                thread {
                    try {
                        HubClient(base, prefs.token).registerFcmToken(token)
                    } catch (_: Exception) {
                    }
                }
            }
        } catch (_: Throwable) {
        }
    }
}
