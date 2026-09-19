package com.app.syncshot.sync

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.database.ContentObserver
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import com.app.syncshot.data.FirebaseRepo
import com.app.syncshot.data.Prefs
import com.app.syncshot.data.ScreenshotPaging
import com.app.syncshot.data.db.AppDb
import com.app.syncshot.data.db.ScreenshotEntity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import java.util.Collections

/** One foreground service does both directions:
 *  - observes new phone screenshots -> enqueues UploadWorker (publish to Firebase)
 *  - holds the Firestore screenshots listener -> mirrors docs into Room (instant
 *    grid) and downloads + notify-to-copy for shots from other devices. */
class SyncService : Service() {
    private var observer: ContentObserver? = null
    private var lastSeenId: Long = 0
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val uploadsInFlight = Collections.synchronizedSet(mutableSetOf<Long>())

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
        startScreenshotObserverIfPermitted()
        startMirror()
    }

    private fun startMirror() {
        scope.launch {
            if (!FirebaseRepo.signedIn) { stopSelf(); return@launch }
            Fcm.registerToken(this@SyncService)
            watchOwnRevocation()
            val dao = AppDb.get(this@SyncService).screenshots()
            // A previous session may have paged the entire library into Room. Do
            // not render that stale, unbounded cache on a fresh launch: start
            // with the newest Firestore page and grow only when the user scrolls.
            // Optimistic local captures stay intact (clearSynced excludes them).
            dao.clearSynced()
            ScreenshotPaging.reset()
            // All devices share one auth uid — our own docs are identified by
            // the per-install deviceId, not the uid.
            val prefs = Prefs(this@SyncService)
            val myDeviceId = prefs.deviceId
            // A force-stop/relaunch must treat the first server snapshot as a
            // baseline, even when an old persisted watermark is 0. Otherwise
            // every screenshot created while the app was away is replayed as a
            // "new" notification. This marker deliberately lives only for this
            // service session; later snapshots are the live-notification stream.
            var notificationBaselineReady = false
            var notificationHighWater = Long.MIN_VALUE
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
                    // Notify only genuinely-new shots from another device, never
                    // a force-stop/relaunch backlog. The first authoritative
                    // snapshot establishes this SERVICE SESSION'S high-water mark
                    // and emits no notifications; cache snapshots never establish
                    // it. Later snapshots handle only "full" docs above that mark.
                    if (!notificationBaselineReady) {
                        if (!page.fromCache) {
                            notificationHighWater = docs.maxOfOrNull { it.createdAt } ?: 0L
                            // Retain this only as diagnostic/legacy state. The
                            // in-memory baseline above is authoritative at the
                            // next service start, so stale values cannot replay a
                            // whole library after force-stop.
                            prefs.screenshotHighWater = notificationHighWater
                            notificationBaselineReady = true
                        }
                    } else {
                        // Process oldest-first so a failed download blocks the
                        // cursor before newer timestamps can skip past it. The
                        // next authoritative snapshot retries it; existing local
                        // files make successful retries a cheap no-op.
                        val pending = docs
                            .asSequence()
                            .filter {
                                it.deviceId != myDeviceId && it.status == "full" &&
                                    it.createdAt > notificationHighWater
                            }
                            .sortedBy { it.createdAt }
                            .toList()
                        for (doc in pending) {
                            if (!Receiver.receive(this@SyncService, doc)) break
                            notificationHighWater = doc.createdAt
                            prefs.screenshotHighWater = notificationHighWater
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

    /** The user may decline photo access (remote syncing should still work), or
     * grant it after this foreground service has started. Never query MediaStore
     * without the runtime grant, and make a later start command attach exactly
     * one observer. */
    private fun startScreenshotObserverIfPermitted() {
        if (observer != null || !hasImagePermission()) return
        lastSeenId = latestImageId()
        registerObserver()
    }

    private fun hasImagePermission(): Boolean {
        val permission = if (Build.VERSION.SDK_INT >= 33) {
            android.Manifest.permission.READ_MEDIA_IMAGES
        } else {
            android.Manifest.permission.READ_EXTERNAL_STORAGE
        }
        return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED
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
                uploadImmediately(id, uri)
            }
        }
    }

    /**
     * The service is already a foreground process, so handing a live capture to
     * WorkManager adds scheduler latency for no benefit. Read and publish it now;
     * WorkManager remains the durable offline/process-death fallback only.
     *
     * MediaStore may notify while the screenshot writer is still finalizing the
     * row. A few short retries cover that race without delaying the normal path.
     */
    private fun uploadImmediately(id: Long, uri: Uri) {
        if (!uploadsInFlight.add(id)) return
        scope.launch {
            try {
                var bytes: ByteArray? = null
                for (attempt in 0 until 4) {
                    bytes = runCatching {
                        contentResolver.openInputStream(uri)?.use { it.readBytes() }
                    }.getOrNull()?.takeIf { it.isNotEmpty() }
                    if (bytes != null) break
                    delay(75L * (attempt + 1))
                }
                val image = bytes ?: error("Screenshot is not readable yet")
                FirebaseRepo.publishScreenshot(this@SyncService, image)
            } catch (_: Exception) {
                UploadWorker.enqueue(this@SyncService, uri)
            } finally {
                uploadsInFlight.remove(id)
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Re-check on every explicit start so granting image access from the UI
        // after the service was already alive enables local screenshot uploads.
        startScreenshotObserverIfPermitted()
        return START_STICKY
    }

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
