package com.app.syncshot.data

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** All publish entry points share this coordinator. A retry must keep the same
 * identity even if the process dies before the first Firestore write succeeds. */
class ScreenshotUploads {
    data class Existing(val id: String, val complete: Boolean)
    private val locks = Array(32) { Mutex() }

    suspend fun publish(
        uid: String,
        sha: String,
        lookup: suspend () -> List<Existing>,
        isDeleted: () -> Boolean = { false },
        upload: suspend (String) -> Unit,
    ): String? = withImage(uid, sha) {
        if (isDeleted()) return@withImage null
        val existing = lookup().sortedWith(
            compareByDescending<Existing> { it.complete }.thenBy { it.id },
        ).firstOrNull()
        val id = existing?.id ?: "sha256-$sha"
        // A thumbnail-only document is unfinished work, not a successful upload.
        if (existing?.complete != true) upload(id)
        id
    }
    suspend fun <T> withImage(uid: String, sha: String, operation: suspend () -> T): T =
        locks[("$uid/$sha".hashCode() and Int.MAX_VALUE) % locks.size].withLock { operation() }
}
