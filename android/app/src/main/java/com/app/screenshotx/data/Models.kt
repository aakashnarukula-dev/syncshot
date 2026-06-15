package com.app.screenshotx.data

import com.google.firebase.firestore.DocumentSnapshot

const val PLATFORM_ANDROID = "android"

/** A screenshot document under users/{uid}/screenshots/{id}. */
data class ScreenshotDoc(
    val id: String,
    val sha256: String,
    val createdAt: Long,
    val deviceUid: String,
    val deviceId: String,
    val deviceName: String,
    val platform: String,
    val width: Int,
    val height: Int,
    val bytes: Long,
    val mime: String,
    val thumbPath: String?,
    val fullPath: String?,
    val status: String,
) {
    companion object {
        /** Uses ESTIMATE for the server timestamp so optimistic local writes sort
         *  to the top before the server resolves `createdAt`. */
        fun from(doc: DocumentSnapshot): ScreenshotDoc? {
            val sha = doc.getString("sha256") ?: return null
            @Suppress("UNCHECKED_CAST")
            val device = doc.get("device") as? Map<String, Any?> ?: emptyMap()
            val created = doc.getDate("createdAt", DocumentSnapshot.ServerTimestampBehavior.ESTIMATE)
            return ScreenshotDoc(
                id = doc.id,
                sha256 = sha,
                createdAt = created?.time ?: System.currentTimeMillis(),
                deviceUid = device["uid"] as? String ?: "",
                deviceId = device["deviceId"] as? String ?: "",
                deviceName = device["name"] as? String ?: "",
                platform = device["platform"] as? String ?: "",
                width = (doc.getLong("width") ?: 0L).toInt(),
                height = (doc.getLong("height") ?: 0L).toInt(),
                bytes = doc.getLong("bytes") ?: 0L,
                mime = doc.getString("mime") ?: "image/png",
                thumbPath = doc.getString("thumbPath"),
                fullPath = doc.getString("fullPath"),
                status = doc.getString("status") ?: "thumb",
            )
        }
    }
}

/** A registered device under users/{uid}/devices/{deviceId}. Written by each
 *  device's heartbeat (FirebaseRepo.updateDevice). `revoked` is set remotely by
 *  another device's "log out this device" action; the target device watches its
 *  own doc and signs itself out when it flips true. */
data class DeviceDoc(
    val id: String,
    val name: String,
    val platform: String,
    val lastSeenAt: Long,
    val revoked: Boolean,
) {
    companion object {
        fun from(doc: DocumentSnapshot): DeviceDoc? {
            if (!doc.exists()) return null
            val created = doc.getDate("lastSeenAt", DocumentSnapshot.ServerTimestampBehavior.ESTIMATE)
            return DeviceDoc(
                id = doc.id,
                name = doc.getString("name") ?: "Device",
                platform = doc.getString("platform") ?: "",
                lastSeenAt = created?.time ?: 0L,
                revoked = doc.getBoolean("revoked") ?: false,
            )
        }
    }
}

/** A clipboard document under users/{uid}/clipboard/{id}. */
data class ClipItem(
    val id: String,
    val text: String,
    val hash: String,
    val createdAt: Long,
    val deviceName: String,
    val pinned: Boolean,
    val charCount: Int,
) {
    companion object {
        fun from(doc: DocumentSnapshot): ClipItem? {
            val text = doc.getString("text") ?: return null
            @Suppress("UNCHECKED_CAST")
            val device = doc.get("device") as? Map<String, Any?> ?: emptyMap()
            val created = doc.getDate("createdAt", DocumentSnapshot.ServerTimestampBehavior.ESTIMATE)
            return ClipItem(
                id = doc.id,
                text = text,
                hash = doc.getString("hash") ?: "",
                createdAt = created?.time ?: System.currentTimeMillis(),
                deviceName = device["name"] as? String ?: "",
                pinned = doc.getBoolean("pinned") ?: false,
                charCount = (doc.getLong("charCount") ?: text.length.toLong()).toInt(),
            )
        }
    }
}
