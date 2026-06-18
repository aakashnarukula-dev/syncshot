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
 * DEEPER on-device finding (Samsung): the OnPrimaryClipChangedListener does NOT fire for a
 * background app at all on this OEM. Samsung's ClipboardService gates *listener delivery*
 * itself on clipboard-access, so a background `onClipChanged()` never runs → the
 * foreground-moment read is never triggered → nothing publishes. Logcat shows the
 * accessibility selection path working ("selection tracked") but never "listener fired".
 *
 * PRIMARY background trigger is therefore the AccessibilityService event stream, which keeps
 * receiving events while we're backgrounded:
 *   - Track the latest selected text on TYPE_VIEW_TEXT_SELECTION_CHANGED (and best-effort on
 *     TYPE_VIEW_TEXT_CHANGED) into [lastSelectionText].
 *   - Detect a COPY action: when the user taps "Copy"/"Cut" in the text-selection floating
 *     toolbar a TYPE_VIEW_CLICKED fires whose node text/contentDescription is the localized
 *     "Copy"/"Cut" label. On such a click we publish [lastSelectionText] directly (it == the
 *     text being copied). If there's no selection (e.g. a "Copy link" button), we fall back to
 *     [ClipReadActivity] (the foreground-moment real-clipboard read).
 *
 * SECONDARY (kept, harmless): the OnPrimaryClipChangedListener still works in the foreground
 * and on non-Samsung OEMs, and the foreground-moment read. De-dup ([lastPublishedText] +
 * debounce) stops the same copy publishing twice across the listener path and the a11y path.
 */
class ClipboardCaptureService : AccessibilityService() {
    private var clipboard: ClipboardManager? = null
    private var listener: ClipboardManager.OnPrimaryClipChangedListener? = null

    /** Most recent text selection seen via accessibility events (primary publish source). */
    @Volatile private var lastSelectionText: String? = null

    /** When [lastSelectionText] was last updated — gates the speculative selection-copy fallback. */
    @Volatile private var lastSelectionAt = 0L

    /** Debounce: a single copy can fire the listener several times in a row. */
    private var lastFireAt = 0L

    /** Debounce: a copy tap can emit several click events; also stops listener+a11y racing. */
    private var lastCopyClickAt = 0L

    /** Debounce: one copy emits several "Copied to clipboard" toasts (app toast + system toast). */
    private var lastToastReadAt = 0L

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
        when (event.eventType) {
            AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED,
            AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED -> trackSelection(event)
            AccessibilityEvent.TYPE_VIEW_CLICKED,
            AccessibilityEvent.TYPE_VIEW_LONG_CLICKED -> maybeCopyClick(event)
            AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED -> maybeClipboardToast(event)
        }
    }

    /** Remember the user's current text selection — this is what a text copy puts on the clip. */
    private fun trackSelection(event: AccessibilityEvent) {
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
                lastSelectionAt = SystemClock.uptimeMillis()
                Log.i(TAG, "selection tracked len=${sel.length}")
            }
        } catch (e: Throwable) {
            Log.w(TAG, "selection track failed", e)
        }
    }

    /**
     * PRIMARY background trigger. A tap on the "Copy"/"Cut" button in the text-selection
     * floating toolbar surfaces as a CLICKED event whose label is the localized action name.
     * On a match we publish the tracked selection (== the copied text); if there's no
     * selection we fall back to the foreground-moment real-clipboard read.
     */
    private fun maybeCopyClick(event: AccessibilityEvent) {
        val label = clickedLabel(event)
        if (label == null) {
            Log.i(
                TAG,
                "click no usable label (near-miss) cls=${event.className} pkg=${event.packageName}"
            )
            return
        }
        if (!isCopyLabel(label)) {
            // Some apps (e.g. X/Twitter's in-app text selection) report the toolbar "Copy" tap as a
            // CLICKED on the underlying text view — the label is the SELECTED text, not "Copy", and no
            // "Copied" toast fires. If the clicked text matches the text we just saw selected, treat it
            // as a probable copy and do a foreground-moment read. publish() de-dups, so a non-copy tap
            // on selected text is harmless (reads the unchanged clip → skipped).
            val sel = lastSelectionText
            val nowSpec = SystemClock.uptimeMillis()
            if (!sel.isNullOrBlank() && nowSpec - lastSelectionAt < SELECTION_WINDOW_MS &&
                label.contains(sel)
            ) {
                if (nowSpec - lastCopyClickAt < DEBOUNCE_MS) {
                    Log.i(TAG, "speculative selection-copy debounced (${nowSpec - lastCopyClickAt}ms)")
                    return
                }
                lastCopyClickAt = nowSpec
                Log.i(TAG, "click==recent selection, no copy label -> speculative foreground read")
                launchForegroundRead()
                return
            }
            Log.i(
                TAG,
                "click label not a copy action (near-miss) label='${label.take(40)}' " +
                    "cls=${event.className} pkg=${event.packageName}"
            )
            return
        }
        val now = SystemClock.uptimeMillis()
        if (now - lastCopyClickAt < DEBOUNCE_MS) {
            Log.i(TAG, "a11y copy debounced duplicate (${now - lastCopyClickAt}ms)")
            return
        }
        lastCopyClickAt = now
        val sel = lastSelectionText
        Log.i(TAG, "a11y copy detected (label='$label'), selLen=${sel?.length ?: 0}")
        if (!sel.isNullOrBlank()) {
            publish(applicationContext, "a11y-copy", sel)
        } else {
            Log.i(TAG, "a11y-copy: no selection -> foreground-moment read")
            launchForegroundRead()
        }
    }

    /**
     * STRONG cross-app fallback. Many apps surface a copy NOT as a TYPE_VIEW_CLICKED on a labelled
     * "Copy" button — on-device, X/Twitter's "Copy link" emits NO click event at all; its only a11y
     * signal is the "Copied to clipboard" confirmation Toast (a TYPE_NOTIFICATION_STATE_CHANGED whose
     * source is an android.widget.Toast). Android 13+ additionally shows a system "Copied to clipboard"
     * toast (pkg com.android.systemui) for every copy. On such a toast we open the foreground-moment
     * activity to read the ACTUAL clipboard and publish it.
     *
     * Safe because [publish] de-dups on [lastPublishedText] (a copy already captured by the click path
     * won't double-publish). We also suppress this briefly right after a click-path copy to avoid a
     * redundant invisible foreground-read, and debounce the duplicate toasts a single copy emits.
     */
    private fun maybeClipboardToast(event: AccessibilityEvent) {
        val text = event.text?.joinToString(" ")?.lowercase()
        if (text.isNullOrBlank() || !isCopyToast(text)) return
        val now = SystemClock.uptimeMillis()
        // The click path (Chrome / selection toolbar) already captured this copy.
        if (now - lastCopyClickAt < TOAST_SUPPRESS_AFTER_CLICK_MS) {
            Log.i(TAG, "copy-toast ignored (click path handled ${now - lastCopyClickAt}ms ago)")
            return
        }
        // One copy emits several toasts (app toast then system toast, ~2s apart) — read once.
        if (now - lastToastReadAt < TOAST_DEBOUNCE_MS) {
            Log.i(TAG, "copy-toast debounced (${now - lastToastReadAt}ms)")
            return
        }
        lastToastReadAt = now
        Log.i(TAG, "copy-toast detected pkg=${event.packageName} -> foreground-moment read")
        launchForegroundRead()
    }

    private fun isCopyToast(lower: String): Boolean = COPY_TOAST_HINTS.any { lower.contains(it) }

    /** Pull a usable label off a CLICKED node (event text, then source text/contentDescription). */
    private fun clickedLabel(event: AccessibilityEvent): String? {
        event.text?.joinToString("")?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        event.contentDescription?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        return try {
            val node = event.source ?: return null
            node.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }
                ?: node.contentDescription?.toString()?.trim()?.takeIf { it.isNotEmpty() }
        } catch (e: Throwable) {
            null
        }
    }

    /**
     * Robust, locale-tolerant copy-label match. Exact-matches the known labels, else does a
     * word-boundary "copy"/"cut" match so variants like "Copy link to post", "Copy text",
     * "Copy URL", "Cut" all count — while NOT matching substrings like "shortcut" or unrelated
     * actions. Word boundary keeps it from firing on every label that happens to contain the
     * letters.
     */
    private fun isCopyLabel(label: String): Boolean =
        COPY_LABELS.any { it.equals(label, ignoreCase = true) } || COPY_WORD.containsMatchIn(label)

    override fun onInterrupt() {}

    override fun onDestroy() {
        listener?.let { l -> clipboard?.removePrimaryClipChangedListener(l) }
        super.onDestroy()
    }

    companion object {
        private const val TAG = "SSXClip"
        private const val DEBOUNCE_MS = 400L

        /** After a click-path copy, ignore the follow-up "Copied" toast (already captured). */
        private const val TOAST_SUPPRESS_AFTER_CLICK_MS = 3000L

        /** A single copy emits an app toast then a system toast ~2s apart — read once per window. */
        private const val TOAST_DEBOUNCE_MS = 3000L

        /** How recent a text selection must be to treat a matching CLICKED as a probable copy. */
        private const val SELECTION_WINDOW_MS = 8000L

        /**
         * Labels of the text-selection toolbar / share-sheet "copy" actions we react to. Device
         * locale is en-IN. Exact list documents the common ones; [COPY_WORD] generalises it.
         */
        private val COPY_LABELS = listOf(
            "Copy", "Cut", "Copy text", "Copy link", "Copy link address", "Copy URL"
        )

        /** Word-boundary "copy"/"cut" — matches "Copy link to post" but not "shortcut". */
        private val COPY_WORD = Regex("\\b(copy|cut)\\b", RegexOption.IGNORE_CASE)

        /**
         * Substrings of a "copied to clipboard" confirmation toast (X's own toast + the Android 13+
         * system toast). Lower-cased before matching. Covers "Copied to clipboard", "Link copied",
         * "Copied!", etc. en-IN device.
         */
        private val COPY_TOAST_HINTS = listOf("copied", "clipboard")

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
