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
import com.app.screenshotx.data.Prefs
import com.app.screenshotx.data.ScreenshotPaging
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
            if (!FirebaseRepo.signedIn) { stopSelf(); return@launch }
            Fcm.registerToken(this@SyncService)
            watchOwnRevocation()
            val dao = AppDb.get(this@SyncService).screenshots()
            // All devices share one auth uid — our own docs are identified by
            // the per-install deviceId, not the uid.
            val myDeviceId = Prefs(this@SyncService).deviceId
            // The grid grows ScreenshotPaging.limit as the user scrolls; each new
            // value re-subscribes the listener at the larger page size (collectLatest
            // cancels the prior listener). The newest `limit` docs are always
            // included, so live captures still arrive at the top.
            ScreenshotPaging.limit.collectLatest { limit ->
                FirebaseRepo.screenshotSnapshots(limit).collectLatest { docs ->
                    dao.upsertAll(docs.map { ScreenshotEntity.of(it) })
                    // Propagate deletes from other devices: any local row inside the
                    // snapshot's time window that the snapshot no longer carries was
                    // deleted elsewhere. Bounded to the window so paged history past
                    // the current page is never wiped; skipped on an empty snapshot
                    // to avoid clearing on a transient.
                    if (docs.isNotEmpty()) {
                        dao.pruneWithinWindow(docs.map { it.id }, docs.minOf { it.createdAt })
                    }
                    docs.forEach { doc ->
                        if (doc.deviceId != myDeviceId && doc.status == "full") {
                            scope.launch { Receiver.receive(this@SyncService, doc) }
                        }
                    }
                }
            }
        }
    }

    /** Remote per-device logout: if another device marks this device's doc revoked,
     *  sign out locally and stop syncing. MainActivity's auth listener then routes
     *  back to sign-in. */
    private fun watchOwnRevocation() {
        scope.launch {
            val myDeviceId = Prefs(this@SyncService).deviceId
            FirebaseRepo.deviceRevokedFlow(myDeviceId).collectLatest { revoked ->
                if (revoked) {
                    runCatching { AppDb.get(this@SyncService).clearAllTables() }
                    runCatching { FirebaseRepo.signOutLocal(this@SyncService) }
                    stopSelf()
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
