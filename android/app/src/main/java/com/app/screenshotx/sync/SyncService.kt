package com.app.screenshotx.sync

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
import com.app.screenshotx.data.FirebaseRepo
import com.app.screenshotx.data.db.AppDb
import com.app.screenshotx.data.db.ScreenshotEntity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/** One foreground service does both directions:
 *  - observes new phone screenshots -> enqueues UploadWorker (publish to Firebase)
 *  - holds the Firestore screenshots listener -> mirrors docs into Room (instant
 *    grid) and downloads + notify-to-copy for shots from other devices. */
class SyncService : Service() {
    private var observer: ContentObserver? = null
    private var lastSeenId: Long = 0
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

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
        startMirror()
    }

    private fun startMirror() {
        scope.launch {
            val libId = FirebaseRepo.currentLibId(this@SyncService) ?: run { stopSelf(); return@launch }
            Fcm.registerToken(this@SyncService)
            val dao = AppDb.get(this@SyncService).screenshots()
            val myUid = FirebaseRepo.uid
            FirebaseRepo.screenshotSnapshots(libId).collectLatest { docs ->
                dao.upsertAll(docs.map { ScreenshotEntity.of(it) })
                docs.forEach { doc ->
                    if (doc.deviceUid != myUid && doc.status == "full") {
                        scope.launch { Receiver.receive(this@SyncService, doc) }
                    }
                }
            }
        }
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
            MediaStore.Images.Media.RELATIVE_PATH,
            MediaStore.Images.Media.BUCKET_DISPLAY_NAME,
        )
        val sel = "${MediaStore.Images.Media._ID} > ?"
        contentResolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI, proj, sel,
            arrayOf(lastSeenId.toString()), "${MediaStore.Images.Media._ID} ASC"
        )?.use { c ->
            val idCol = c.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            val pathCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.RELATIVE_PATH)
            val bucketCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.BUCKET_DISPLAY_NAME)
            while (c.moveToNext()) {
                val id = c.getLong(idCol)
                lastSeenId = maxOf(lastSeenId, id)
                val where = (c.getString(pathCol) ?: "") + (c.getString(bucketCol) ?: "")
                if (!where.contains("Screenshot", ignoreCase = true)) continue
                val uri = Uri.withAppendedPath(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id.toString())
                UploadWorker.enqueue(this, uri)
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        observer?.let { contentResolver.unregisterContentObserver(it) }
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        fun start(ctx: Context) {
            val i = Intent(ctx, SyncService::class.java)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }
    }
}
