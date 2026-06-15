package com.app.screenshotx.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.app.screenshotx.data.FirebaseRepo

/** Re-attach the sync service after a reboot so realtime receive keeps working. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED && FirebaseRepo.signedIn) {
            SyncService.start(context)
        }
    }
}
