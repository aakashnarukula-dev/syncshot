package com.app.screenshotx.coil

import coil.ImageLoader
import coil.decode.DataSource
import coil.decode.ImageSource
import coil.fetch.FetchResult
import coil.fetch.Fetcher
import coil.fetch.SourceResult
import coil.key.Keyer
import coil.request.Options
import com.google.firebase.storage.StorageReference
import kotlinx.coroutines.tasks.await
import okio.Buffer

/** Lets Coil load a Firebase [StorageReference] directly (thumb.webp / full.png).
 *  Pair with a per-request diskCacheKey of the sha256 for content-addressed caching. */
class StorageFetcher(
    private val ref: StorageReference,
    private val options: Options,
) : Fetcher {

    override suspend fun fetch(): FetchResult {
        val bytes = ref.getBytes(MAX_BYTES).await()
        return SourceResult(
            source = ImageSource(Buffer().apply { write(bytes) }, options.context),
            mimeType = null,
            dataSource = DataSource.NETWORK,
        )
    }

    class Factory : Fetcher.Factory<StorageReference> {
        override fun create(data: StorageReference, options: Options, imageLoader: ImageLoader) =
            StorageFetcher(data, options)
    }

    companion object {
        private const val MAX_BYTES = 64L * 1024 * 1024
    }
}

class StorageKeyer : Keyer<StorageReference> {
    override fun key(data: StorageReference, options: Options): String = data.path
}
