package com.app.syncshot.data

import android.app.Activity
import android.content.Context
import android.os.Build
import com.app.syncshot.data.db.AppDb
import com.app.syncshot.data.db.ScreenshotEntity
import com.google.firebase.Firebase
import com.google.firebase.FirebaseException
import com.google.firebase.auth.PhoneAuthCredential
import com.google.firebase.auth.PhoneAuthOptions
import com.google.firebase.auth.PhoneAuthProvider
import com.google.firebase.auth.auth
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.MetadataChanges
import com.google.firebase.firestore.Query
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
 * Single Firebase entry point. Identity = phone OTP sign-in: every device
 * signs in to the same account and reads/writes users/{uid}/... directly.
 * Per-device identity (to skip our own docs on receive) is Prefs.deviceId,
 * not the shared auth uid.
 */
object FirebaseRepo {
    private const val MAX_CLIP_BYTES = 100 * 1024

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

    // --- Phone OTP sign-in ------------------------------------------------------

    private var verificationId: String? = null

    /** Text a 6-digit code to `phone` (E.164). App verification (Play Integrity /
     *  reCAPTCHA fallback) needs the foreground Activity. */
    fun sendPhoneOtp(
        activity: Activity,
        phone: String,
        onSent: () -> Unit,
        onAutoSignedIn: () -> Unit,
        onError: (Throwable) -> Unit,
    ) {
        val options = PhoneAuthOptions.newBuilder(auth)
            .setPhoneNumber(phone)
            .setTimeout(60L, java.util.concurrent.TimeUnit.SECONDS)
            .setActivity(activity)
            .setCallbacks(object : PhoneAuthProvider.OnVerificationStateChangedCallbacks() {
                override fun onVerificationCompleted(credential: PhoneAuthCredential) {
                    // Instant verification / auto SMS retrieval — no code entry needed.
                    auth.currentUser?.takeIf { it.isAnonymous }?.let { auth.signOut() }
                    auth.signInWithCredential(credential)
                        .addOnSuccessListener { onAutoSignedIn() }
                        .addOnFailureListener { onError(it) }
                }

                override fun onVerificationFailed(e: FirebaseException) = onError(e)

                override fun onCodeSent(id: String, token: PhoneAuthProvider.ForceResendingToken) {
                    verificationId = id
                    onSent()
                }
            })
            .build()
        PhoneAuthProvider.verifyPhoneNumber(options)
    }

    /** Complete sign-in with the SMS code. */
    suspend fun signInWithOtp(code: String) {
        val id = verificationId ?: error("Request a code first")
        val cred = PhoneAuthProvider.getCredential(id, code.trim())
        auth.currentUser?.takeIf { it.isAnonymous }?.let { auth.signOut() }
        auth.signInWithCredential(cred).await()
    }

    /** Complete sign-in with a Firebase custom token (e.g. minted by the
     *  SyncShot Truecaller server). The server keys it to the same uid as
     *  phone-OTP, so the account/library is identical either way. */
    suspend fun signInWithCustomToken(token: String) {
        auth.currentUser?.takeIf { it.isAnonymous }?.let { auth.signOut() }
        auth.signInWithCustomToken(token).await()
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
    suspend fun publishScreenshot(ctx: Context, full: ByteArray) = coroutineScope {
        val uid = requireUid()
        val sha = Hashing.sha256(full)
        val type = detectImageType(full)
        cacheFullLocally(ctx, sha, full, type.mime)

        // Thumbnail encoding is independent of the network dedupe lookup. Run
        // them together so a fresh capture reaches the thumb upload as soon as
        // the slower of the two completes, instead of paying both costs serially.
        val preparedThumb = async(Dispatchers.Default) { Thumbs.make(full) }
        val existing = col("screenshots").whereEqualTo("sha256", sha).limit(1).get().await()
        if (!existing.isEmpty) {
            preparedThumb.cancel()
            return@coroutineScope
        }

        val docRef = col("screenshots").document()
        val id = docRef.id
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

        val thumb = preparedThumb.await()
        if (thumb == null) {
            fullUpload.cancel()
            return@coroutineScope
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
        docRef.set(
            mapOf(
                "sha256" to sha,
                "createdAt" to FieldValue.serverTimestamp(),
                "device" to deviceMap(ctx),
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
        ).await()

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
    }

    suspend fun downloadFull(path: String, maxBytes: Long = 64L * 1024 * 1024): ByteArray =
        storage.getReference(path).getBytes(maxBytes).await()

    /** Delete a screenshot everywhere in the cloud: its Firestore doc AND both
     *  Storage blobs (thumb + full). Mirrors the Mac delete — the deterministic
     *  users/{uid}/screenshots/{id}/{thumb.webp,full.png} paths plus whatever the
     *  doc carried are all swept, and a missing blob is not an error. Removing the
     *  doc is what stops every device's listener from re-syncing the shot. */
    suspend fun deleteScreenshot(id: String, thumbPath: String?, fullPath: String?) {
        val uid = requireUid()
        val blobs = linkedSetOf(
            "users/$uid/screenshots/$id/thumb.webp",
            "users/$uid/screenshots/$id/full.png",
        )
        thumbPath?.let(blobs::add)
        fullPath?.let(blobs::add)
        blobs.forEach { p -> runCatching { storage.getReference(p).delete().await() } }
        col("screenshots").document(id).delete().await()
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
