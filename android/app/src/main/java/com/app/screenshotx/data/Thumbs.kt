package com.app.screenshotx.data

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
        val src = BitmapFactory.decodeByteArray(full, 0, full.size) ?: return null
        val w = src.width
        val h = src.height
        val longest = max(w, h)
        val scaled = if (longest > MAX_EDGE) {
            val factor = MAX_EDGE.toFloat() / longest
            Bitmap.createScaledBitmap(src, (w * factor).roundToInt(), (h * factor).roundToInt(), true)
        } else src
        val out = ByteArrayOutputStream()
        @Suppress("DEPRECATION")
        scaled.compress(Bitmap.CompressFormat.WEBP, QUALITY, out)
        return Result(out.toByteArray(), w, h)
    }
}
