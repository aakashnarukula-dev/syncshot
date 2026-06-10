package com.aakash.ssx.sync

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.database.ContentObserver
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.MediaStore
import com.aakash.ssx.data.HubClient
import com.aakash.ssx.data.Prefs
import okhttp3.WebSocket

/** One foreground service does both directions:
 *  - observes new phone screenshots -> enqueues UploadWorker
 *  - holds a WebSocket to the hub -> downloads received shots + notifies (notify-to-copy). */
class SyncService : Service() {
    private var observer: ContentObserver? = null
    private var ws: WebSocket? = null
    private var lastSeenId: Long = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Notifications.ensureChannels(this)
        val notif = Notifications.serviceNotification(this)
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(1, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(1, notif)
        }
        lastSeenId = latestImageId()
        registerObserver()
        connectWs()
    }

    private fun registerObserver() {
        val obs = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean, uri: Uri?) {
                checkForNewScreenshots()
            }
        }
        contentResolver.registerContentObserver(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true, obs
        )
        observer = obs
    }

    private fun latestImageId(): Long {
        val proj = arrayOf(MediaStore.Images.Media._ID)
        contentResolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI, proj, null, null,
            "${MediaStore.Images.Media.DATE_ADDED} DESC"
        )?.use { c -> if (c.moveToFirst()) return c.getLong(0) }
        return 0
    }

    private fun checkForNewScreenshots() {
        val proj = arrayOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.RELATIVE_PATH,
            MediaStore.Images.Media.BUCKET_DISPLAY_NAME,
        )
        val sel = "${MediaStore.Images.Media._ID} > ?"
        contentResolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI, proj, sel,
            arrayOf(lastSeenId.toString()), "${MediaStore.Images.Media._ID} ASC"
        )?.use { c ->
            val idCol = c.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            val nameCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME)
            val pathCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.RELATIVE_PATH)
            val bucketCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.BUCKET_DISPLAY_NAME)
            while (c.moveToNext()) {
                val id = c.getLong(idCol)
                lastSeenId = maxOf(lastSeenId, id)
                val name = c.getString(nameCol) ?: continue
                val where = (c.getString(pathCol) ?: "") + (c.getString(bucketCol) ?: "")
                if (!where.contains("Screenshot", ignoreCase = true)) continue
                val uri = Uri.withAppendedPath(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id.toString())
                UploadWorker.enqueue(this, uri, name)
            }
        }
    }

    private fun connectWs() {
        val prefs = Prefs(this)
        val base = prefs.baseUrl ?: return
        ws = HubClient(base, prefs.token).openEvents { hash -> Receiver.receive(this, hash) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        observer?.let { contentResolver.unregisterContentObserver(it) }
        ws?.cancel()
        super.onDestroy()
    }

    companion object {
        fun start(ctx: Context) {
            val i = Intent(ctx, SyncService::class.java)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }
    }
}
