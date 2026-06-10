package com.aakash.ssx

import android.app.Application
import coil.ImageLoader
import coil.ImageLoaderFactory
import com.aakash.ssx.data.Prefs
import okhttp3.OkHttpClient

/** Application that gives Coil an OkHttp client which attaches the device bearer
 *  token, so thumbnails/images from the (auth-gated) hub load directly. */
class SsxApp : Application(), ImageLoaderFactory {
    override fun newImageLoader(): ImageLoader {
        val prefs = Prefs(this)
        val client = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val token = prefs.token
                val req = if (token != null) {
                    chain.request().newBuilder()
                        .header("Authorization", "Bearer $token")
                        .build()
                } else {
                    chain.request()
                }
                chain.proceed(req)
            }
            .build()
        return ImageLoader.Builder(this)
            .okHttpClient(client)
            .crossfade(true)
            .build()
    }
}
