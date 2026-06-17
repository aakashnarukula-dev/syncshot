package com.app.screenshotx.sync

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import com.app.screenshotx.data.FirebaseRepo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Share target. A "share URL" (or any text) from another app's share sheet lands
 * here via ACTION_SEND text/plain — this is the reliable capture path because the
 * background clipboard listener never fires for a share action (and on Samsung it
 * never fires in the background at all). The user picks ScreenshotX from the share
 * sheet; we publish the shared text/URL through the same writeClipboard path used
 * by the clipboard capture, so existing dedup (latest-hash) and the size cap apply.
 */
class ShareActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val text = extractSharedText(intent)
        if (text.isNullOrBlank()) {
            finish()
            return
        }
        if (!FirebaseRepo.signedIn) {
            Toast.makeText(this, "Sign in to ScreenshotX to save", Toast.LENGTH_SHORT).show()
            finish()
            return
        }
        val app = applicationContext
        CoroutineScope(Dispatchers.IO).launch {
            runCatching { FirebaseRepo.writeClipboard(app, text) }
        }
        Toast.makeText(this, "Saved to ScreenshotX", Toast.LENGTH_SHORT).show()
        finish()
    }

    private fun extractSharedText(intent: Intent?): String? {
        if (intent?.action != Intent.ACTION_SEND) return null
        val ext = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
        if (!ext.isNullOrBlank()) return ext
        // Some apps put the URL in the subject instead of the body.
        return intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.toString()
    }
}
