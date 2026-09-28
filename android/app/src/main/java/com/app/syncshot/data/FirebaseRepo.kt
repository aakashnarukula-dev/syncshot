package com.app.syncshot.data

import android.content.Context
import android.os.Build
import com.app.syncshot.data.db.AppDb
import com.app.syncshot.data.db.ScreenshotEntity
import com.google.firebase.Firebase
import com.google.firebase.auth.auth
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.MetadataChanges
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.Source
import com.google.firebase.firestore.SetOptions
import com.google.firebase.firestore.firestore
import com.google.firebase.storage.StorageMetadata
import com.google.firebase.storage.StorageReference
import com.google.firebase.storage.storage
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await

/**
 * Single Firebase entry point. Identity = Google sign-in: every device
 * signs in to the same account and reads/writes users/{uid}/... directly.
 * Per-device identity (to skip our own docs on receive) is Prefs.deviceId,
 * not the shared auth uid.
 */
object FirebaseRepo {
    private const val MAX_CLIP_BYTES = 100 * 1024
    private val screenshotUploads = ScreenshotUploads()

    private val auth get() = Firebase.auth
    private val db get() = Firebase.firestore
    private val storage get() = Firebase.storage

    val uid: String? get() = auth.currentUser?.uid

    /** Phone number of the signed-in account (E.164), for the Profile screen. */
    val phoneNumber: String? get() = auth.currentUser?.phoneNumber

    /** Signed in with a real (non-anonymous) account. */
    val signedIn: Boolean get() = auth.currentUser?.isAnonymous == false

    /** Drop any leftover anonymous session from pre-OTP builds, then report state. */
    fun purgeAnonymousAndCheck(): Boolean {
        auth.currentUser?.takeIf { it.isAnonymous }?.let { auth.signOut() }
        return signedIn
    }

    /** Sign this device out and clear local state, including downloaded images. */
    fun signOutLocal(ctx: Context) {
        auth.signOut()
        Prefs(ctx).clear()
        runCatching { java.io.File(ctx.filesDir, "received").deleteRecursively() }
        runCatching { java.io.File(ctx.cacheDir, "shared").deleteRecursively() }
    }

    // --- Paths ------------------------------------------------------------------

    private fun requireUid(): String {
        val u = auth.currentUser
        check(u != null && !u.isAnonymous) { "Not signed in" }
        return u.uid
    }

    private fun col(name: String): CollectionReference =
        db.collection("users").document(requireUid()).collection(name)

    private fun deviceMap(ctx: Context): Map<String, Any> = mapOf(
        "uid" to requireUid(),
        "deviceId" to Prefs(ctx).deviceId,
        "name" to (Build.MODEL ?: "Android"),
        "platform" to PLATFORM_ANDROID,
    )

    fun storageRef(path: String): StorageReference = storage.getReference(path)

    // --- SyncShot ----------------------------------------------------------

    /** Cache a screenshot's full bytes under their actual image extension — the
     *  same location Receiver uses — so a local capture renders instantly without
     *  mislabelling a JPEG/HEIC payload as PNG. */
    private fun cacheFullLocally(ctx: Context, sha: String, full: ByteArray, mime: String) {
        runCatching {
            val f = ImageFiles.receivedFile(ctx, sha, mime)
            if (!f.exists() || f.length() == 0L) f.writeBytes(full)
        }
    }

    /** Real image type sniffed from the bytes' magic numbers — phone screenshots are
     *  often JPEG (e.g. Samsung), not PNG, so we must not blindly label them .png /
     *  image/png. Falls back to PNG only when nothing matches. */
    private data class ImageType(val ext: String, val mime: String)

    private fun detectImageType(b: ByteArray): ImageType {
        fun u(i: Int) = if (i < b.size) b[i].toInt() and 0xFF else -1
        return when {
            u(0) == 0xFF && u(1) == 0xD8 && u(2) == 0xFF -> ImageType("jpg", "image/jpeg")
            u(0) == 0x89 && u(1) == 0x50 && u(2) == 0x4E && u(3) == 0x47 -> ImageType("png", "image/png")
            u(0) == 0x47 && u(1) == 0x49 && u(2) == 0x46 -> ImageType("gif", "image/gif")
            u(0) == 0x52 && u(1) == 0x49 && u(2) == 0x46 && u(3) == 0x46 &&
                u(8) == 0x57 && u(9) == 0x45 && u(10) == 0x42 && u(11) == 0x50 ->
                ImageType("webp", "image/webp")
            // ISO-BMFF "ftyp" box at offset 4 → HEIC/HEIF.
            u(4) == 0x66 && u(5) == 0x74 && u(6) == 0x79 && u(7) == 0x70 -> ImageType("heic", "image/heic")
            else -> ImageType("png", "image/png")
        }
    }

    /** Publish a screenshot: dedupe by sha256, thumbnail-first, then full. */
    suspend fun publishScreenshot(ctx: Context, full: ByteArray, manual: Boolean = false) {
        val uid = requireUid()
        AccountAccess.requireActive()
        check(requireUid() == uid) { "Account changed during upload" }
        val sha = Hashing.sha256(full)
        val type = detectImageType(full)
        val prefs = Prefs(ctx)

        val screenshots = db.collection("users").document(uid).collection("screenshots")
        val id = screenshotUploads.publish(uid, sha, isDeleted = { !manual && prefs.isScreenshotDeleted(uid, sha) }, lookup = {
            if (manual) prefs.restoreScreenshot(uid, sha)
            screenshots.whereEqualTo("sha256", sha).get(Source.SERVER).await().documents.map {
                ScreenshotUploads.Existing(it.id, it.getString("status") == "full" && !it.getString("fullPath").isNullOrBlank())
            }
        }, upload = { id -> coroutineScope {
            cacheFullLocally(ctx, sha, full, type.mime)
            val docRef = screenshots.document(id)
            val thumb = kotlinx.coroutines.withContext(Dispatchers.Default) { Thumbs.make(full) }
                ?: error("Screenshot is not a complete, readable image")
            val thumbPath = "users/$uid/screenshots/$id/thumb.webp"
            val fullPath = "users/$uid/screenshots/$id/full.${type.ext}"
            val fullRef = storage.getReference(fullPath)

            // Start the multi-megabyte original immediately. It runs alongside the
            // tiny thumbnail encode/upload instead of waiting behind it, so the Mac
            // clipboard can receive the original within seconds of the rail preview.
            val fullUpload = async {
                fullRef
                    .putBytes(full, StorageMetadata.Builder().setContentType(type.mime).build())
                    .await()
            }

            // Optimistic local row: the grid mirrors Room, so writing the row now (with
            // status "local") makes the just-captured shot appear and render from its
            // cached local file IMMEDIATELY — instead of only after the thumb finishes
            // uploading and the Firestore doc is created. The server snapshot later
            // upserts the same id (flipping status to thumb/full); the delete-reconcile
            // never prunes status="local" rows, so this can't be wiped before it syncs.
            runCatching {
                AppDb.get(ctx).screenshots().upsertAll(
                    listOf(
                        ScreenshotEntity(
                            id = id,
                            sha256 = sha,
                            createdAt = System.currentTimeMillis(),
                            deviceUid = uid,
                            deviceName = Build.MODEL ?: "Android",
                            platform = PLATFORM_ANDROID,
                            width = thumb.width,
                            height = thumb.height,
                            bytes = full.size.toLong(),
                            mime = type.mime,
                            thumbPath = null,
                            fullPath = null,
                            status = "local",
                        )
                    )
                )
            }

            val thumbRef = storage.getReference(thumbPath)
            thumbRef
                .putBytes(thumb.bytes, StorageMetadata.Builder().setContentType("image/webp").build())
                .await()
            val metadata = mapOf(
                    "sha256" to sha,
                    "device" to mapOf("uid" to uid, "deviceId" to Prefs(ctx).deviceId, "name" to (Build.MODEL ?: "Android"), "platform" to PLATFORM_ANDROID),
                    "width" to thumb.width,
                    "height" to thumb.height,
                    "mime" to type.mime,
                    "thumbPath" to thumbPath,
                    "thumbUrl" to null,
                    // The path is deterministic and safe to publish while bytes
                    // finish uploading. Status remains "thumb" until completion.
                    "fullPath" to fullPath,
                    "fullUrl" to null,
                    "status" to "thumb",
                )
            // Preserve creation time on retries and never downgrade another
            // device's completed upload back to thumbnail-only.
            db.runTransaction { transaction ->
                val current = transaction.get(docRef)
                if (!current.exists()) {
                    transaction.set(docRef, metadata + ("createdAt" to FieldValue.serverTimestamp()))
                } else if (current.getString("status") != "full") {
                    transaction.set(docRef, metadata, SetOptions.merge())
                }
            }.await()

            val thumbUrlUpdate = async {
                runCatching {
                    docRef.update("thumbUrl", thumbRef.downloadUrl.await().toString()).await()
                }
            }
            fullUpload.await()
            docRef.update(
                mapOf(
                    "status" to "full",
                    "fullPath" to fullPath,
                    "bytes" to full.size.toLong(),
                )
            ).await()

            // URL metadata is an optimization, never a delivery gate. Storage paths
            // are already usable by both apps if either lookup is briefly slow.
            thumbUrlUpdate.await()
            runCatching { docRef.update("fullUrl", fullRef.downloadUrl.await().toString()).await() }
        } }) ?: return
        // Repair orphan optimistic rows from older retry attempts without
        // deleting any original image or cloud document.
        AppDb.get(ctx).screenshots().removeLocalDuplicates(sha, id)
    }

    suspend fun downloadFull(path: String, maxBytes: Long = 64L * 1024 * 1024): ByteArray =
        storage.getReference(path).getBytes(maxBytes).await()

    /** Delete a screenshot everywhere in the cloud: its Firestore doc AND both
     *  Storage blobs (thumb + full). Mirrors the Mac delete — the deterministic
     *  users/{uid}/screenshots/{id}/{thumb.webp,full.png} paths plus whatever the
     *  doc carried are all swept, and a missing blob is not an error. Removing the
     *  doc is what stops every device's listener from re-syncing the shot. */
    suspend fun deleteScreenshot(ctx: Context, item: ScreenshotEntity) {
        val uid = requireUid()
        screenshotUploads.withImage(uid, item.sha256) {
            val screenshots = db.collection("users").document(uid).collection("screenshots")
            val copies = if (item.sha256.isBlank()) emptyList() else
                screenshots.whereEqualTo("sha256", item.sha256).get(Source.SERVER).await().documents
            val pathsById = copies.associate { doc ->
                doc.id to listOfNotNull(doc.getString("thumbPath"), doc.getString("fullPath"))
            }.toMutableMap()
            pathsById[item.id] = pathsById[item.id].orEmpty() + listOfNotNull(item.thumbPath, item.fullPath)
            for ((id, paths) in pathsById) {
                val blobs = paths + listOf("users/$uid/screenshots/$id/thumb.webp", "users/$uid/screenshots/$id/full.png")
                // Keep the row until cloud deletion succeeds; failed calls remain retryable.
                screenshots.document(id).delete().await()
                blobs.distinct().forEach { path -> runCatching { storage.getReference(path).delete().await() } }
            }
            // A queued upload must not resurrect the user's deleted image after restart.
            Prefs(ctx).markScreenshotDeleted(uid, item.sha256)
            AppDb.get(ctx).screenshots().deleteImage(item.sha256, item.id)
            ImageFiles.deleteCachedCopies(ctx, item.sha256)
        }
    }

    /** A screenshot listener emission plus whether it came from the local cache.
     *  Deletes must only be reconciled from authoritative server snapshots
     *  ([fromCache] = false) — a partial cache emission while a larger page is still
     *  loading would otherwise look like "the collection shrank". */
    data class ScreenshotPage(val docs: List<ScreenshotDoc>, val fromCache: Boolean)

    /** Realtime screenshot snapshots, newest first, capped at [limit]. The cap is
     *  paged: the grid grows it (SyncService re-subscribes) as the user scrolls,
     *  instead of pulling the whole history up front. Always includes the newest
     *  `limit` docs, so fresh captures still stream in at the top. Includes
     *  optimistic local writes (pending serverTimestamps estimate to ~now → top). */
    fun screenshotSnapshots(limit: Long): Flow<ScreenshotPage> = callbackFlow {
        val reg = col("screenshots")
            .orderBy("createdAt", Query.Direction.DESCENDING)
            .limit(limit)
            .addSnapshotListener(MetadataChanges.INCLUDE) { snap, _ ->
                if (snap != null) trySend(
                    ScreenshotPage(
                        snap.documents.mapNotNull { ScreenshotDoc.from(it) },
                        snap.metadata.isFromCache,
                    )
                )
            }
        awaitClose { reg.remove() }
    }

    // --- Devices (Profile / per-device revocation) ----------------------------

    /** All registered devices for this account, newest-seen first, revoked ones
     *  filtered out. Backs the Profile "other devices" list. */
    fun deviceSnapshots(): Flow<List<DeviceDoc>> = callbackFlow {
        val reg = col("devices").addSnapshotListener { snap, _ ->
            if (snap != null) trySend(
                snap.documents.mapNotNull { DeviceDoc.from(it) }
                    .filter { !it.revoked }
                    .sortedByDescending { it.lastSeenAt }
            )
        }
        awaitClose { reg.remove() }
    }

    /** Remotely log a device out: mark its doc revoked and drop its FCM token, so it
     *  stops receiving wake-pings and signs itself out when it next sees the doc
     *  (SyncService watches its own device doc via [deviceRevokedFlow]). */
    suspend fun revokeDevice(deviceId: String) {
        col("devices").document(deviceId)
            .set(mapOf("revoked" to true, "fcmToken" to FieldValue.delete()), SetOptions.merge())
            .await()
    }

    /** Emits true once this device's own doc is marked revoked elsewhere. */
    fun deviceRevokedFlow(deviceId: String): Flow<Boolean> = callbackFlow {
        val reg = col("devices").document(deviceId).addSnapshotListener { snap, _ ->
            trySend(snap?.getBoolean("revoked") == true)
        }
        awaitClose { reg.remove() }
    }

    // --- ClipboardX -----------------------------------------------------------

    /** Write a clipboard entry, dropping it if it duplicates the most-recent hash
     *  or exceeds the 100 KB text cap. */
    suspend fun writeClipboard(ctx: Context, text: String) {
        AccountAccess.requireActive()
        if (text.isBlank()) return
        if (text.toByteArray(Charsets.UTF_8).size > MAX_CLIP_BYTES) return
        val hash = Hashing.sha256(text.toByteArray(Charsets.UTF_8))

        val latest = col("clipboard")
            .orderBy("createdAt", Query.Direction.DESCENDING).limit(1).get().await()
        if (latest.documents.firstOrNull()?.getString("hash") == hash) return

        col("clipboard").add(
            mapOf(
                "text" to text,
                "hash" to hash,
                "createdAt" to FieldValue.serverTimestamp(),
                "device" to deviceMap(ctx),
                "pinned" to false,
                "charCount" to text.length,
            )
        ).await()
    }

    fun clipboardSnapshots(): Flow<List<ClipItem>> = callbackFlow {
        val reg = col("clipboard")
            .orderBy("createdAt", Query.Direction.DESCENDING)
            .limit(200)
            .addSnapshotListener(MetadataChanges.INCLUDE) { snap, _ ->
                if (snap != null) trySend(snap.documents.mapNotNull { ClipItem.from(it) })
            }
        awaitClose { reg.remove() }
    }

    /** Best-effort: store this device's FCM token + heartbeat on its device doc so
     *  a future wake-ping can target it. Merge-write; safe if some fields are absent. */
    suspend fun updateDevice(ctx: Context, fields: Map<String, Any>) {
        if (!signedIn) return
        col("devices").document(Prefs(ctx).deviceId)
            .set(
                fields + mapOf(
                    "lastSeenAt" to FieldValue.serverTimestamp(),
                    "name" to (Build.MODEL ?: "Android"),
                    "platform" to PLATFORM_ANDROID,
                ),
                SetOptions.merge(),
            )
            .await()
    }

    suspend fun setClipPinned(id: String, pinned: Boolean) {
        col("clipboard").document(id).update("pinned", pinned).await()
    }

    suspend fun deleteClip(id: String) {
        col("clipboard").document(id).delete().await()
    }
}
