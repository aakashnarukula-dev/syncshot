package com.app.screenshotx

import android.app.Application
import coil.ImageLoader
import coil.ImageLoaderFactory
import coil.disk.DiskCache
import coil.memory.MemoryCache
import com.app.screenshotx.coil.StorageFetcher
import com.app.screenshotx.coil.StorageKeyer
import com.google.firebase.Firebase
import com.google.firebase.firestore.firestore
import com.google.firebase.firestore.firestoreSettings
import com.google.firebase.firestore.persistentCacheSettings

/** Turns on Firestore offline persistence (zero-latency cold render) and teaches
 *  Coil to load Firebase Storage references for screenshot thumbnails. */
class SsxApp : Application(), ImageLoaderFactory {
    override fun onCreate() {
        super.onCreate()
        runCatching {
            Firebase.firestore.firestoreSettings = firestoreSettings {
                setLocalCacheSettings(persistentCacheSettings { })
            }
        }
    }

    override fun newImageLoader(): ImageLoader =
        ImageLoader.Builder(this)
            .components {
                add(StorageFetcher.Factory())
                add(StorageKeyer())
            }
            // Persistent caches so thumbs survive across launches and aren't
            // re-downloaded from Storage every time the gallery opens. Keys are
            // content-addressed (sha256) by imageModel, so a cache hit is instant.
            .memoryCache {
                MemoryCache.Builder(this)
                    .maxSizePercent(0.25)
                    .build()
            }
            .diskCache {
                DiskCache.Builder()
                    .directory(cacheDir.resolve("image_cache"))
                    .maxSizeBytes(256L * 1024 * 1024)
                    .build()
            }
            // Storage responses carry no cache headers; cache them anyway.
            .respectCacheHeaders(false)
            .crossfade(true)
            .build()
}
