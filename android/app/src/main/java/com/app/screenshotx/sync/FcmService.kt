package com.app.screenshotx.sync

import android.content.Context
import com.app.screenshotx.data.FirebaseRepo
import com.app.screenshotx.data.Prefs
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/** Wake-ping: a data message from another device's capture wakes a killed app so
 *  SyncService can attach the Firestore listener and the new shot syncs through. */
class FcmService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        if (Prefs(this).isPaired) SyncService.start(this)
    }

    override fun onNewToken(token: String) {
        if (!Prefs(this).isPaired) return
        CoroutineScope(Dispatchers.IO).launch {
            runCatching { FirebaseRepo.updateMember(applicationContext, mapOf("fcmToken" to token)) }
        }
    }
}

object Fcm {
    /** Fetch the current token and store it on the member doc (best-effort). */
    fun registerToken(ctx: Context) {
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
            if (token.isNullOrBlank()) return@addOnSuccessListener
            CoroutineScope(Dispatchers.IO).launch {
                runCatching { FirebaseRepo.updateMember(ctx.applicationContext, mapOf("fcmToken" to token)) }
            }
        }
    }
}
