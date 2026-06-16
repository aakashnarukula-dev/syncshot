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
        // Safety net: if focus never arrives, force a final attempt and finish.
        timeout.postDelayed({ tryRead(final = true) }, TIMEOUT_MS)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) tryRead(final = false)
    }

    private fun tryRead(final: Boolean) {
        if (handled) return
        val text = readClipOrFallback()
        if (text.isBlank()) {
            if (final) {
                Log.w(TAG, "foreground read empty + no fallback, giving up")
                handled = true
                doFinish()
            } else {
                Log.i(TAG, "read empty on focus, awaiting retry/timeout")
            }
            return
        }
        handled = true
        timeout.removeCallbacksAndMessages(null)
        Log.i(TAG, "foreground read OK len=${text.length}")
        ClipboardCaptureService.publish(applicationContext, "fg-read", text)
        doFinish()
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
        private const val TIMEOUT_MS = 2000L
        const val EXTRA_FALLBACK = "fallback_text"
    }
}
