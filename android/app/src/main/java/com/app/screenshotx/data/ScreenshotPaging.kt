package com.app.screenshotx.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

/** Shared cursor for the paged screenshot listener. The grid (UI) bumps the cap as
 *  the user scrolls near the end; SyncService observes [limit] and re-subscribes
 *  the Firestore listener at the new size. Process-global so the UI and the
 *  foreground service share one value. */
object ScreenshotPaging {
    /** Enough to fill the viewport + a small buffer without pulling everything. */
    const val PAGE: Long = 40

    val limit = MutableStateFlow(PAGE)

    /** Pull the next page in (scrolled near the end). */
    fun loadMore() = limit.update { it + PAGE }

    /** Back to the first page (pull-to-refresh from the top). */
    fun reset() = limit.update { PAGE }
}
