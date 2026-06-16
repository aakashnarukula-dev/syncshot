package com.app.screenshotx.sync

import android.accessibilityservice.AccessibilityService
import android.content.ClipboardManager
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.TextUtils
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import com.app.screenshotx.data.FirebaseRepo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Background clipboard capture. Android 10+ blocks normal apps from reading the
 * clipboard in the background; an AccessibilityService is the sanctioned workaround
 * — while connected it holds enough window context to read `ClipboardManager` on a
 * primary-clip-changed callback. (Must be verified on a real device.)
 */
class ClipboardCaptureService : AccessibilityService() {
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var clipboard: ClipboardManager? = null
    private var listener: ClipboardManager.OnPrimaryClipChangedListener? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        val cm = getSystemService(ClipboardManager::class.java)
        if (cm == null) {
            Log.e(TAG, "onServiceConnected: ClipboardManager unavailable")
            return
        }
        val l = ClipboardManager.OnPrimaryClipChangedListener { capture(cm) }
        // Register on the main thread so the OnPrimaryClipChangedListener callback is
        // dispatched on a thread with a Looper (onServiceConnected already runs on main,
        // but post defensively in case the platform changes the calling thread).
        Handler(Looper.getMainLooper()).post {
            cm.addPrimaryClipChangedListener(l)
            Log.i(TAG, "service connected, listener registered")
        }
        clipboard = cm
        listener = l
    }

    private fun capture(cm: ClipboardManager) {
        val clip = cm.primaryClip
        if (clip == null) {
            Log.w(TAG, "clip changed: primaryClip=null (OS withheld clipboard)")
            return
        }
        Log.i(TAG, "clip changed: itemCount=${clip.itemCount}")
        if (clip.itemCount == 0) return
        val text = clip.getItemAt(0).coerceToText(this)?.toString().orEmpty()
        if (text.isBlank()) {
            Log.w(TAG, "clip changed: blank/non-text item, skipping")
            return
        }
        // Privacy: log length only, never the clip text.
        val uid = FirebaseRepo.uid
        if (uid == null) {
            Log.w(TAG, "skip publish: uid=null (not signed in), len=${text.length}")
            return
        }
        Log.i(TAG, "uid present, publishing len=${text.length}")
        scope.launch {
            try {
                FirebaseRepo.writeClipboard(applicationContext, text)
                Log.i(TAG, "published len=${text.length}")
            } catch (e: Throwable) {
                Log.e(TAG, "publish failed", e)
            }
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    override fun onDestroy() {
        listener?.let { l -> clipboard?.removePrimaryClipChangedListener(l) }
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "SSXClip"

        /** True if the user has enabled this accessibility service in Settings. */
        fun isEnabled(ctx: android.content.Context): Boolean {
            val flat = Settings.Secure.getString(
                ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ) ?: return false
            val target = "${ctx.packageName}/${ClipboardCaptureService::class.java.name}"
            val splitter = TextUtils.SimpleStringSplitter(':')
            splitter.setString(flat)
            while (splitter.hasNext()) {
                if (splitter.next().equals(target, ignoreCase = true)) return true
            }
            return false
        }
    }
}
