package com.app.screenshotx.data

import com.google.firebase.firestore.DocumentSnapshot

const val PLATFORM_ANDROID = "android"

/** A screenshot document under libraries/{libId}/screenshots/{id}. */
data class ScreenshotDoc(
    val id: String,
    val sha256: String,
    val createdAt: Long,
    val deviceUid: String,
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

/** A clipboard document under libraries/{libId}/clipboard/{id}. */
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
