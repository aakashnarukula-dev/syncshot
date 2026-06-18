package com.app.screenshotx.sync

import android.app.Activity
import android.content.ClipboardManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.WindowManager

/**
 * Invisible "foreground moment" used to read the clipboard in the background.
 *
 * Android 10+ allows clipboard reads only for the focused app, so [ClipboardCaptureService]
 * (background) cannot read it. When a primary-clip-changed fires while we're backgrounded,
 * the service launches this activity. The window is 1x1 px, fully transparent, no enter/exit
 * animation and excluded from recents — so the flash is imperceptible. Once focused it IS the
 * foreground app, `getPrimaryClip()` is allowed, it publishes via
 * [ClipboardCaptureService.publish] and finishes immediately.
 */
class ClipReadActivity : Activity() {
    @Volatile private var handled = false
    private val timeout = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Make the window effectively invisible: 1px, top-start, transparent, untouchable.
        window.setLayout(1, 1)
        window.attributes = window.attributes.apply {
            gravity = Gravity.TOP or Gravity.START
            x = 0
            y = 0
            alpha = 0f
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE)
        overridePendingTransition(0, 0)
        Log.i(TAG, "ClipReadActivity created (foreground moment)")
    }

    override fun onResume() {
        super.onResume()
        // A background-launched 1px/alpha-0 window often never gets onWindowFocusChanged(true), and
        // the clipboard read is denied until we are actually the foreground app — which lands a beat
        // after onResume. So instead of a single timed read, POLL with backoff: the first attempt
        // that the OS lets through wins. Much more reliable (and faster) than one 2s timeout, which
        // could be missed entirely if the activity is torn down early.
        poll(0)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) tryRead(final = false)
    }

    /** Attempt a read; if still denied/empty, retry on a backoff schedule until [READ_BACKOFF_MS] runs out. */
    private fun poll(idx: Int) {
        if (handled) return
        if (tryRead(final = idx >= READ_BACKOFF_MS.size - 1)) return
        if (idx < READ_BACKOFF_MS.size - 1) {
            timeout.postDelayed({ poll(idx + 1) }, READ_BACKOFF_MS[idx + 1] - READ_BACKOFF_MS[idx])
        }
    }

    /** @return true once handled (published or finally gave up); false if a retry should follow. */
    private fun tryRead(final: Boolean): Boolean {
        if (handled) return true
        val text = readClipOrFallback()
        if (text.isBlank()) {
            if (final) {
                Log.w(TAG, "foreground read empty + no fallback, giving up")
                handled = true
                doFinish()
                return true
            }
            return false
        }
        handled = true
        timeout.removeCallbacksAndMessages(null)
        Log.i(TAG, "foreground read OK len=${text.length}")
        ClipboardCaptureService.publish(applicationContext, "fg-read", text)
        doFinish()
        return true
    }

    private fun readClipOrFallback(): String {
        val cm = getSystemService(ClipboardManager::class.java)
        if (cm == null) {
            Log.e(TAG, "ClipboardManager null")
        } else {
            val clip = cm.primaryClip
            if (clip != null && clip.itemCount > 0) {
                val mime = clip.description?.getMimeType(0).orEmpty()
                if (mime.startsWith("text/")) {
                    val t = clip.getItemAt(0).coerceToText(this)?.toString().orEmpty()
                    if (t.isNotBlank()) return t
                } else {
                    Log.i(TAG, "non-text clip mime=$mime, ignoring")
                }
            } else {
                Log.w(TAG, "foreground getPrimaryClip null/empty")
            }
        }
        // Fall back to the selection the service remembered from accessibility events.
        val fb = intent.getStringExtra(EXTRA_FALLBACK).orEmpty()
        if (fb.isNotBlank()) Log.i(TAG, "using selection fallback len=${fb.length}")
        return fb
    }

    private fun doFinish() {
        if (isFinishing) return
        finish()
        overridePendingTransition(0, 0)
    }

    override fun onDestroy() {
        timeout.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    companion object {
        private const val TAG = "SSXClip"

        /** Cumulative ms offsets to retry the clipboard read at (covers ~2.5s of focus latency). */
        private val READ_BACKOFF_MS = longArrayOf(0, 120, 280, 500, 800, 1200, 1700, 2300)
        const val EXTRA_FALLBACK = "fallback_text"
    }
}
