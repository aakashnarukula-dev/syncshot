package com.app.screenshotx.data

import android.app.Activity
import android.content.Context
import android.os.Build
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
import com.google.firebase.storage.StorageReference
import com.google.firebase.storage.storage
import kotlinx.coroutines.channels.awaitClose
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
     *  ScreenshotX Truecaller server). The server keys it to the same uid as
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

    // --- ScreenshotX ----------------------------------------------------------

    /** Publish a screenshot: dedupe by sha256, thumbnail-first, then full. */
    suspend fun publishScreenshot(ctx: Context, full: ByteArray) {
        val uid = requireUid()
        val sha = Hashing.sha256(full)

        val existing = col("screenshots").whereEqualTo("sha256", sha).limit(1).get().await()
        if (!existing.isEmpty) return

        val thumb = Thumbs.make(full) ?: return
        val docRef = col("screenshots").document()
        val id = docRef.id
        val thumbPath = "users/$uid/screenshots/$id/thumb.webp"
        val fullPath = "users/$uid/screenshots/$id/full.png"

        storage.getReference(thumbPath).putBytes(thumb.bytes).await()
        docRef.set(
            mapOf(
                "sha256" to sha,
                "createdAt" to FieldValue.serverTimestamp(),
                "device" to deviceMap(ctx),
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
    fun screenshotSnapshots(): Flow<List<ScreenshotDoc>> = callbackFlow {
        val reg = col("screenshots")
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
