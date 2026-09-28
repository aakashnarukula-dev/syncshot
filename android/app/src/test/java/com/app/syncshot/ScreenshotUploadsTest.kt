package com.app.syncshot

import com.app.syncshot.data.ScreenshotUploads
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class ScreenshotUploadsTest {
    @Test
    fun failedAttemptsAndProcessRestartsReuseOneLocalRow() = runBlocking {
        val localRows = mutableSetOf<String>()
        val cloudRows = mutableMapOf<String, ScreenshotUploads.Existing>()
        repeat(4) { attempt ->
            // Recreate the coordinator to model WorkManager after process death.
            val result = runCatching {
                ScreenshotUploads().publish("user", "hash", { cloudRows.values.toList() }) { id ->
                    localRows.add(id)
                    if (attempt < 3) error("Connection lost before Firestore creation")
                    cloudRows[id] = ScreenshotUploads.Existing(id, true)
                }
            }
            assertEquals(attempt == 3, result.isSuccess)
        }
        assertEquals(setOf("sha256-hash"), localRows)
        assertEquals(localRows, cloudRows.keys)
    }

    @Test
    fun fourConcurrentNotificationsUploadOnce() = runBlocking {
        val coordinator = ScreenshotUploads()
        var remote: ScreenshotUploads.Existing? = null
        var uploads = 0
        val ids = (1..4).map {
            async {
                coordinator.publish("user", "hash", { delay(5); listOfNotNull(remote) }) { id ->
                    uploads++
                    delay(10)
                    remote = ScreenshotUploads.Existing(id, true)
                }
            }
        }.awaitAll()
        assertEquals(1, uploads)
        assertEquals(1, ids.toSet().size)
    }

    @Test
    fun interruptedFullUploadResumesLegacyDocument() = runBlocking {
        var resumed: String? = null
        val id = ScreenshotUploads().publish("user", "hash", {
            listOf(ScreenshotUploads.Existing("old-random-id", false))
        }) { resumed = it }
        assertEquals("old-random-id", id)
        assertEquals(id, resumed)
    }

    @Test
    fun completeCopyWinsOverUnfinishedDuplicate() = runBlocking {
        val id = ScreenshotUploads().publish("user", "hash", {
            listOf(ScreenshotUploads.Existing("a-partial", false), ScreenshotUploads.Existing("z-full", true))
        }) { fail("Complete image must not be uploaded again") }
        assertEquals("z-full", id)
    }

    @Test
    fun failedLookupDoesNotCreateAnotherPreview() = runBlocking {
        val result = runCatching {
            ScreenshotUploads().publish("user", "hash", { error("Offline") }) {
                fail("Do not invent a new document from an incomplete cache")
            }
        }
        assertTrue(result.isFailure)
    }
    @Test
    fun queuedRetryCannotResurrectDeletedImage() = runBlocking {
        var deleted = false
        val coordinator = ScreenshotUploads()
        coordinator.withImage("user", "hash") { deleted = true }
        // The persisted deletion flag survives a new worker/coordinator process.
        val result = ScreenshotUploads().publish("user", "hash", lookup = {
            fail("Deleted upload must stop before any cloud work")
            emptyList()
        }, isDeleted = { deleted }) {
            fail("A queued retry must not recreate a deleted row")
        }
        assertNull(result)
    }

    @Test
    fun deletionWaitsForActiveUploadAndStopsNextRetry() = runBlocking {
        val coordinator = ScreenshotUploads()
        val started = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        var deleted = false
        val visible = mutableSetOf<String>()
        val upload = async {
            coordinator.publish("user", "hash", { emptyList() }) { id ->
                started.complete(Unit)
                finish.await()
                visible.add(id)
            }
        }
        started.await()
        val delete = async {
            coordinator.withImage("user", "hash") {
                visible.clear()
                deleted = true
            }
        }
        finish.complete(Unit)
        upload.await()
        delete.await()
        val retry = coordinator.publish("user", "hash", { emptyList() }, { deleted }) { visible.add(it) }
        assertNull(retry)
        assertTrue(visible.isEmpty())
    }

}
