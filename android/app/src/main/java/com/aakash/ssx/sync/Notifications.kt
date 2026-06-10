package com.aakash.ssx.sync

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import androidx.core.app.NotificationCompat
import com.aakash.ssx.R
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
            .setContentTitle("ScreenshotX")
            .setContentText("Syncing screenshots")
            .setSmallIcon(R.drawable.ic_stat_frame)
            .setOngoing(true)
            .build()

    fun notifyReceived(ctx: Context, hash: String, imageFile: File) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val copyIntent = Intent(ctx, CopyActivity::class.java).apply {
            putExtra("file", imageFile.absolutePath)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        }
        val pi = PendingIntent.getActivity(
            ctx, hash.hashCode(), copyIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val bmp = BitmapFactory.decodeFile(imageFile.absolutePath)
        val builder = NotificationCompat.Builder(ctx, CH_RECEIVED)
            .setContentTitle("New screenshot")
            .setContentText("From another device")
            .setSmallIcon(R.drawable.ic_stat_frame)
            .addAction(0, "Copy", pi)
            .setContentIntent(pi)
            .setAutoCancel(true)
        if (bmp != null) {
            builder.setLargeIcon(bmp)
                .setStyle(NotificationCompat.BigPictureStyle().bigPicture(bmp).bigLargeIcon(null as android.graphics.Bitmap?))
        }
        nm.notify(hash.hashCode(), builder.build())
    }
}
