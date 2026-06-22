package com.app.syncshot.sync

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import androidx.core.app.NotificationCompat
import com.app.syncshot.MainActivity
import com.app.syncshot.R
import java.io.File

object Notifications {
    const val CH_SERVICE = "ssx_service"
    const val CH_RECEIVED = "ssx_received"

    fun ensureChannels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CH_SERVICE, "Sync running", NotificationManager.IMPORTANCE_MIN)
        )
        nm.createNotificationChannel(
            NotificationChannel(CH_RECEIVED, "Received screenshots", NotificationManager.IMPORTANCE_HIGH)
        )
    }

    fun serviceNotification(ctx: Context): Notification =
        NotificationCompat.Builder(ctx, CH_SERVICE)
            .setContentTitle("SyncShot")
            .setContentText("Syncing screenshots")
            .setSmallIcon(R.drawable.ic_stat_frame)
            .setOngoing(true)
            .build()

    /** notify-to-copy: tap the body to open the app, or tap Copy to place the image
     *  on the clipboard (Android only allows a foreground moment to write it). */
    fun notifyReceived(ctx: Context, sha: String, imageFile: File) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val openIntent = Intent(ctx, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        }
        val openPi = PendingIntent.getActivity(
            ctx, sha.hashCode(), openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val copyIntent = Intent(ctx, CopyActivity::class.java).apply {
            putExtra("file", imageFile.absolutePath)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val copyPi = PendingIntent.getActivity(
            ctx, sha.hashCode() + 1, copyIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val bmp = BitmapFactory.decodeFile(imageFile.absolutePath)
        val builder = NotificationCompat.Builder(ctx, CH_RECEIVED)
            .setContentTitle("New screenshot")
            .setContentText("From another device")
            .setSmallIcon(R.drawable.ic_stat_frame)
            .setContentIntent(openPi)
            .addAction(0, "Copy", copyPi)
            .setAutoCancel(true)
        if (bmp != null) {
            builder.setLargeIcon(bmp)
                .setStyle(
                    NotificationCompat.BigPictureStyle().bigPicture(bmp)
                        .bigLargeIcon(null as android.graphics.Bitmap?)
                )
        }
        nm.notify(sha.hashCode(), builder.build())
    }
}
