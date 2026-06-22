package com.app.syncshot.data.db

import androidx.room.Entity
import androidx.room.PrimaryKey
import com.app.syncshot.data.ScreenshotDoc

/** Local mirror of a screenshot doc so the grid renders instantly on cold start,
 *  before any Firestore listener has fired. */
@Entity(tableName = "screenshots")
data class ScreenshotEntity(
    @PrimaryKey val id: String,
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
        fun of(d: ScreenshotDoc) = ScreenshotEntity(
            id = d.id,
            sha256 = d.sha256,
            createdAt = d.createdAt,
            deviceUid = d.deviceUid,
            deviceName = d.deviceName,
            platform = d.platform,
            width = d.width,
            height = d.height,
            bytes = d.bytes,
            mime = d.mime,
            thumbPath = d.thumbPath,
            fullPath = d.fullPath,
            status = d.status,
        )
    }
}
