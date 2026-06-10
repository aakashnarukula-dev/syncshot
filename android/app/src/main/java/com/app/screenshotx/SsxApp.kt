package com.app.screenshotx

import android.app.Application
import coil.ImageLoader
import coil.ImageLoaderFactory
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
            .crossfade(true)
            .build()
}
