package com.app.syncshot.sync

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
import com.app.syncshot.data.FirebaseRepo
import com.app.syncshot.data.Prefs
import com.app.syncshot.data.ScreenshotPaging
import com.app.syncshot.data.db.AppDb
import com.app.syncshot.data.db.ScreenshotEntity
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
            val prefs = Prefs(this@SyncService)
            val myDeviceId = prefs.deviceId
            // The grid grows ScreenshotPaging.limit as the user scrolls; each new
            // value re-subscribes the listener at the larger page size (collectLatest
            // cancels the prior listener). The newest `limit` docs are always
            // included, so live captures still arrive at the top.
            ScreenshotPaging.limit.collectLatest { limit ->
                FirebaseRepo.screenshotSnapshots(limit).collectLatest { page ->
                    val docs = page.docs
                    dao.upsertAll(docs.map { ScreenshotEntity.of(it) })
                    // Reconcile deletes ONLY from authoritative server snapshots — a
                    // partial cache emission must never drive a delete.
                    if (!page.fromCache) {
                        if (docs.size < limit) {
                            // The listener returned fewer than its page limit, so it
                            // reached the end of the collection: `docs` is the COMPLETE
                            // server set. Drop every other local row — this clears
                            // bulk-deleted shots that sit past the page window (and the
                            // whole table when everything was deleted).
                            if (docs.isEmpty()) dao.clearSynced()
                            else dao.keepOnly(docs.map { it.id })
                        } else {
                            // A full page: there may be older docs beyond it, so only
                            // reconcile within this page's time window.
                            dao.pruneWithinWindow(docs.map { it.id }, docs.minOf { it.createdAt })
                        }
                    }
                    // Notify only for GENUINELY-NEW shots from another device, never
                    // the login backlog. On (re)login the listener's first snapshot
                    // carries the ENTIRE existing history; firing a notification per
                    // doc floods the shade. Gate on a persisted high-water-mark
                    // (newest handled createdAt):
                    //  - mark < 0  → not initialized yet. Seed it from the first
                    //    AUTHORITATIVE (server, !fromCache) snapshot: the whole
                    //    current set is pre-existing backlog, so set the mark to its
                    //    newest createdAt (0 if the account is empty) and notify
                    //    nothing. Cache emissions are ignored until then so a cached
                    //    backlog can't slip through before the mark exists.
                    //  - otherwise → notify only docs with createdAt > mark, then
                    //    advance the mark past them. We key on createdAt + status
                    //    "full" (NOT documentChanges ADDED): a shot is first ADDED as
                    //    "thumb" and only later MODIFIED to "full", so an ADDED-only
                    //    filter would fire before the full image is downloadable.
                    //    Advancing the mark ONLY from shots we actually notified means
                    //    a thumb seen ahead of its full (and clock-skewed peers) still
                    //    notifies once the full arrives. Receiver's received/<sha>.png
                    //    existence check is the final dedupe so MetadataChanges cache
                    //    re-delivery can't re-notify the same shot.
                    val mark = prefs.screenshotHighWater
                    if (mark < 0L) {
                        if (!page.fromCache) {
                            prefs.screenshotHighWater = docs.maxOfOrNull { it.createdAt } ?: 0L
                        }
                    } else {
                        var newMark = mark
                        docs.forEach { doc ->
                            if (doc.deviceId != myDeviceId && doc.status == "full" &&
                                doc.createdAt > mark
                            ) {
                                scope.launch { Receiver.receive(this@SyncService, doc) }
                                newMark = maxOf(newMark, doc.createdAt)
                            }
                        }
                        if (newMark > mark) prefs.screenshotHighWater = newMark
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
