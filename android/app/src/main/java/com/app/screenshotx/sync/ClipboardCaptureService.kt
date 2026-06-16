package com.app.screenshotx.sync

import android.accessibilityservice.AccessibilityService
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.text.TextUtils
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import com.app.screenshotx.data.FirebaseRepo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Background clipboard text capture.
 *
 * Android 10+ DENIES clipboard reads to an app that is not the foreground/focused app —
 * this includes an AccessibilityService. Verified on-device: when ScreenshotX is in the
 * background the OS logs "Denying clipboard access ... application is not in focus" and
 * `cm.primaryClip` returns null. So the old approach (read the clip directly inside this
 * service on the primary-clip-changed callback) only works while ScreenshotX is in focus.
 *
 * The OnPrimaryClipChangedListener STILL fires in the background even though the read is
 * denied. We use that signal to open [ClipReadActivity] — a 1px invisible translucent
 * activity that, by virtue of being foreground for a moment, is allowed to read the clip.
 * It reads, publishes, and finishes immediately (imperceptible flash). When ScreenshotX is
 * already in focus we skip the activity and read directly here.
 *
 * Fallback if the OEM blocks the background activity launch: we remember the most recent
 * selected text from accessibility events and publish that instead (heuristic, needs no
 * clipboard permission).
 */
class ClipboardCaptureService : AccessibilityService() {
    private var clipboard: ClipboardManager? = null
    private var listener: ClipboardManager.OnPrimaryClipChangedListener? = null

    /** Most recent text selection seen via accessibility events (fallback source). */
    @Volatile private var lastSelectionText: String? = null

    /** Debounce: a single copy can fire the listener several times in a row. */
    private var lastFireAt = 0L

    override fun onServiceConnected() {
        super.onServiceConnected()
        val cm = getSystemService(ClipboardManager::class.java)
        if (cm == null) {
            Log.e(TAG, "onServiceConnected: ClipboardManager unavailable")
            return
        }
        val l = ClipboardManager.OnPrimaryClipChangedListener { onClipChanged(cm) }
        // Register on the main thread so the callback is dispatched on a Looper thread.
        Handler(Looper.getMainLooper()).post {
            cm.addPrimaryClipChangedListener(l)
            Log.i(TAG, "service connected, listener registered")
        }
        clipboard = cm
        listener = l
    }

    private fun onClipChanged(cm: ClipboardManager) {
        Log.i(TAG, "listener fired")
        val now = SystemClock.uptimeMillis()
        if (now - lastFireAt < DEBOUNCE_MS) {
            Log.i(TAG, "debounced duplicate fire (${now - lastFireAt}ms)")
            return
        }
        lastFireAt = now

        // Try a direct read. Succeeds only when ScreenshotX is the focused app.
        val clip = cm.primaryClip
        if (clip == null || clip.itemCount == 0) {
            Log.w(TAG, "read denied/empty in service (background) -> foreground-moment read")
            launchForegroundRead()
            return
        }
        val mime = clip.description?.getMimeType(0).orEmpty()
        if (!mime.startsWith("text/")) {
            // e.g. an image URI copied by our own CopyActivity — not clipboard text.
            Log.i(TAG, "non-text clip mime=$mime, skipping")
            return
        }
        val text = clip.getItemAt(0).coerceToText(this)?.toString().orEmpty()
        if (text.isBlank()) {
            Log.w(TAG, "read allowed but blank/non-text item, skipping")
            return
        }
        Log.i(TAG, "read allowed in service (foreground), len=${text.length}")
        publish(applicationContext, "fg-direct", text)
    }

    /** Open the invisible activity that can legally read the clipboard while foreground. */
    private fun launchForegroundRead() {
        try {
            val i = Intent(this, ClipReadActivity::class.java).apply {
                addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_NO_ANIMATION or
                        Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
                )
                lastSelectionText?.let { putExtra(ClipReadActivity.EXTRA_FALLBACK, it) }
            }
            startActivity(i)
            Log.i(TAG, "launched ClipReadActivity (foreground moment)")
        } catch (e: Throwable) {
            Log.e(TAG, "ClipReadActivity launch blocked (bg activity launch?)", e)
            // Last resort: publish the remembered selection without any clipboard read.
            val sel = lastSelectionText
            if (!sel.isNullOrBlank()) {
                Log.w(TAG, "using accessibility selection fallback len=${sel.length}")
                publish(applicationContext, "sel-fallback", sel)
            } else {
                Log.w(TAG, "no selection fallback available")
            }
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        if (event.eventType != AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED) return
        try {
            val full = event.text?.joinToString("")?.takeIf { it.isNotEmpty() }
                ?: event.source?.text?.toString()
                ?: return
            val from = event.fromIndex
            val to = event.toIndex
            val sel = if (from in 0..full.length && to in from..full.length && to > from)
                full.substring(from, to) else null
            if (!sel.isNullOrBlank()) {
                lastSelectionText = sel
                Log.i(TAG, "selection tracked len=${sel.length}")
            }
        } catch (e: Throwable) {
            Log.w(TAG, "selection track failed", e)
        }
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        listener?.let { l -> clipboard?.removePrimaryClipChangedListener(l) }
        super.onDestroy()
    }

    companion object {
        private const val TAG = "SSXClip"
        private const val DEBOUNCE_MS = 400L

        /** Process-lifetime scope so a publish survives the launching component finishing. */
        private val publishScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

        /** Last text we published; skip identical consecutive clips (logs showed dupes). */
        @Volatile private var lastPublishedText: String? = null

        /**
         * De-dup + publish a captured clipboard text. Safe to call from the service or from
         * [ClipReadActivity]. Logs every step (lengths only, never content).
         */
        fun publish(ctx: Context, source: String, text: String) {
            if (text.isBlank()) {
                Log.w(TAG, "$source: blank text, skip")
                return
            }
            if (text == lastPublishedText) {
                Log.i(TAG, "$source: duplicate of last published, skip len=${text.length}")
                return
            }
            val uid = FirebaseRepo.uid
            if (uid == null) {
                Log.w(TAG, "$source: skip publish uid=null (not signed in), len=${text.length}")
                return
            }
            lastPublishedText = text
            Log.i(TAG, "$source: uid present, publishing len=${text.length}")
            val appCtx = ctx.applicationContext
            publishScope.launch {
                try {
                    FirebaseRepo.writeClipboard(appCtx, text)
                    Log.i(TAG, "$source: published len=${text.length}")
                } catch (e: Throwable) {
                    Log.e(TAG, "$source: publish failed", e)
                    lastPublishedText = null // allow a retry on the next change
                }
            }
        }

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
