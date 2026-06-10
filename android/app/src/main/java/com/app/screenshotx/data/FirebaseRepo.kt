package com.app.screenshotx.data

import android.content.Context
import android.os.Build
import com.google.firebase.Firebase
import com.google.firebase.auth.auth
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.MetadataChanges
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.firestore
import com.google.firebase.functions.functions
import com.google.firebase.storage.StorageReference
import com.google.firebase.storage.storage
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await

/**
 * Single Firebase entry point — replaces the old HubClient. Owns anonymous auth,
 * the `libId` custom-claim lifecycle, pairing callables, and the ScreenshotX /
 * ClipboardX read/write paths against Firestore + Storage.
 */
object FirebaseRepo {
    const val REGION = "us-central1"
    private const val MAX_CLIP_BYTES = 100 * 1024

    private val auth get() = Firebase.auth
    private val db get() = Firebase.firestore
    private val storage get() = Firebase.storage
    private val functions get() = Firebase.functions(REGION)

    val uid: String? get() = auth.currentUser?.uid

    suspend fun ensureSignedIn(): String {
        auth.currentUser?.let { return it.uid }
        return auth.signInAnonymously().await().user!!.uid
    }

    /** The library this device belongs to, read from the `libId` custom claim. */
    suspend fun currentLibId(ctx: Context, forceRefresh: Boolean = false): String? {
        val user = auth.currentUser ?: return null
        val claim = runCatching {
            user.getIdToken(forceRefresh).await().claims["libId"] as? String
        }.getOrNull()
        if (claim != null) Prefs(ctx).libId = claim
        return claim ?: Prefs(ctx).libId
    }

    private suspend fun requireLibId(ctx: Context): String =
        currentLibId(ctx) ?: error("Not paired")

    private fun col(libId: String, name: String): CollectionReference =
        db.collection("libraries").document(libId).collection(name)

    private fun deviceMap(uid: String): Map<String, Any> =
        mapOf("uid" to uid, "name" to (Build.MODEL ?: "Android"), "platform" to PLATFORM_ANDROID)

    fun storageRef(path: String): StorageReference = storage.getReference(path)

    // --- Pairing (callable Cloud Functions) ----------------------------------

    private suspend fun call(name: String, data: Map<String, Any?>): Map<*, *> {
        val res = functions.getHttpsCallable(name).call(data).await()
        return res.getData() as? Map<*, *> ?: emptyMap<String, Any?>()
    }

    suspend fun createLibrary(ctx: Context): String {
        ensureSignedIn()
        val out = call("createLibrary", mapOf("deviceName" to Prefs(ctx).deviceName, "platform" to PLATFORM_ANDROID))
        val libId = out["libId"] as String
        currentLibId(ctx, forceRefresh = true) // pull the new claim
        Prefs(ctx).libId = libId
        return libId
    }

    suspend fun createPairingCode(): Pair<String, Long> {
        val out = call("createPairingCode", emptyMap())
        val code = out["code"] as String
        val expiresAt = (out["expiresAt"] as? Number)?.toLong() ?: 0L
        return code to expiresAt
    }

    suspend fun redeemPairingCode(ctx: Context, code: String): String {
        ensureSignedIn()
        val out = call(
            "redeemPairingCode",
            mapOf("code" to code, "deviceName" to Prefs(ctx).deviceName, "platform" to PLATFORM_ANDROID),
        )
        val libId = out["libId"] as String
        currentLibId(ctx, forceRefresh = true) // pull the new claim
        Prefs(ctx).libId = libId
        return libId
    }

    // --- ScreenshotX ----------------------------------------------------------

    /** Publish a screenshot: dedupe by sha256, thumbnail-first, then full. */
    suspend fun publishScreenshot(ctx: Context, full: ByteArray) {
        val libId = requireLibId(ctx)
        val uid = ensureSignedIn()
        val sha = Hashing.sha256(full)

        val existing = col(libId, "screenshots").whereEqualTo("sha256", sha).limit(1).get().await()
        if (!existing.isEmpty) return

        val thumb = Thumbs.make(full) ?: return
        val docRef = col(libId, "screenshots").document()
        val id = docRef.id
        val thumbPath = "libraries/$libId/screenshots/$id/thumb.webp"
        val fullPath = "libraries/$libId/screenshots/$id/full.png"

        storage.getReference(thumbPath).putBytes(thumb.bytes).await()
        docRef.set(
            mapOf(
                "sha256" to sha,
                "createdAt" to FieldValue.serverTimestamp(),
                "device" to deviceMap(uid),
                "width" to thumb.width,
                "height" to thumb.height,
                "mime" to "image/png",
                "thumbPath" to thumbPath,
                "status" to "thumb",
            )
        ).await()

        storage.getReference(fullPath).putBytes(full).await()
        docRef.update(
            mapOf(
                "status" to "full",
                "fullPath" to fullPath,
                "bytes" to full.size.toLong(),
            )
        ).await()
    }

    suspend fun downloadFull(path: String, maxBytes: Long = 64L * 1024 * 1024): ByteArray =
        storage.getReference(path).getBytes(maxBytes).await()

    /** Realtime screenshot snapshots (most recent 100). Includes optimistic local writes. */
    fun screenshotSnapshots(libId: String): Flow<List<ScreenshotDoc>> = callbackFlow {
        val reg = col(libId, "screenshots")
            .orderBy("createdAt", Query.Direction.DESCENDING)
            .limit(100)
            .addSnapshotListener(MetadataChanges.INCLUDE) { snap, _ ->
                if (snap != null) trySend(snap.documents.mapNotNull { ScreenshotDoc.from(it) })
            }
        awaitClose { reg.remove() }
    }

    // --- ClipboardX -----------------------------------------------------------

    /** Write a clipboard entry, dropping it if it duplicates the most-recent hash
     *  or exceeds the 100 KB text cap. */
    suspend fun writeClipboard(ctx: Context, text: String) {
        if (text.isBlank()) return
        if (text.toByteArray(Charsets.UTF_8).size > MAX_CLIP_BYTES) return
        val libId = requireLibId(ctx)
        val uid = ensureSignedIn()
        val hash = Hashing.sha256(text.toByteArray(Charsets.UTF_8))

        val latest = col(libId, "clipboard")
            .orderBy("createdAt", Query.Direction.DESCENDING).limit(1).get().await()
        if (latest.documents.firstOrNull()?.getString("hash") == hash) return

        col(libId, "clipboard").add(
            mapOf(
                "text" to text,
                "hash" to hash,
                "createdAt" to FieldValue.serverTimestamp(),
                "device" to deviceMap(uid),
                "pinned" to false,
                "charCount" to text.length,
            )
        ).await()
    }

    fun clipboardSnapshots(libId: String): Flow<List<ClipItem>> = callbackFlow {
        val reg = col(libId, "clipboard")
            .orderBy("createdAt", Query.Direction.DESCENDING)
            .limit(200)
            .addSnapshotListener(MetadataChanges.INCLUDE) { snap, _ ->
                if (snap != null) trySend(snap.documents.mapNotNull { ClipItem.from(it) })
            }
        awaitClose { reg.remove() }
    }

    /** Best-effort: store this device's FCM token + heartbeat on its member doc so a
     *  future wake-ping can target it. Merge-write; safe if some fields are absent. */
    suspend fun updateMember(ctx: Context, fields: Map<String, Any>) {
        val libId = currentLibId(ctx) ?: return
        val uid = uid ?: return
        col(libId, "members").document(uid)
            .set(fields + mapOf("lastSeenAt" to FieldValue.serverTimestamp()), com.google.firebase.firestore.SetOptions.merge())
            .await()
    }

    suspend fun setClipPinned(ctx: Context, id: String, pinned: Boolean) {
        val libId = requireLibId(ctx)
        col(libId, "clipboard").document(id).update("pinned", pinned).await()
    }

    suspend fun deleteClip(ctx: Context, id: String) {
        val libId = requireLibId(ctx)
        col(libId, "clipboard").document(id).delete().await()
    }
}
