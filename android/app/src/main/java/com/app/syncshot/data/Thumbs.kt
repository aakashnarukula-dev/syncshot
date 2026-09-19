package com.app.syncshot.data

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

/** Client-side 320px WebP thumbnail — the speed path (thumbnail-first upload). */
object Thumbs {
    private const val MAX_EDGE = 320
    private const val QUALITY = 70

    data class Result(val bytes: ByteArray, val width: Int, val height: Int)

    /** Returns the WebP thumbnail bytes plus the FULL image's pixel dimensions. */
    fun make(full: ByteArray): Result? {
        // Decode only enough pixels for the 320px result. The old path decoded a
        // 1440x3200 screenshot at full resolution, allocated ~18MB, then scaled it
        // back down. Sampling at decode time is dramatically faster and avoids a
        // transient full-bitmap allocation on screenshot-heavy phones.
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(full, 0, full.size, bounds)
        val w = bounds.outWidth
        val h = bounds.outHeight
        if (w <= 0 || h <= 0) return null

        var sample = 1
        while (w / (sample * 2) >= MAX_EDGE && h / (sample * 2) >= MAX_EDGE) {
            sample *= 2
        }
        val src = BitmapFactory.decodeByteArray(
            full,
            0,
            full.size,
            BitmapFactory.Options().apply { inSampleSize = sample },
        ) ?: return null
        val longest = max(w, h)
        val scaled = if (longest > MAX_EDGE) {
            val factor = MAX_EDGE.toFloat() / longest
            Bitmap.createScaledBitmap(src, (w * factor).roundToInt(), (h * factor).roundToInt(), true)
        } else src
        val out = ByteArrayOutputStream()
        @Suppress("DEPRECATION")
        val encoded = scaled.compress(Bitmap.CompressFormat.WEBP, QUALITY, out)
        if (scaled !== src) scaled.recycle()
        src.recycle()
        if (!encoded) return null
        return Result(out.toByteArray(), w, h)
    }
}
