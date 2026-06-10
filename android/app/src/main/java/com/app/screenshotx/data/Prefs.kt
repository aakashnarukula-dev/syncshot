package com.app.screenshotx.data

import android.content.Context
import android.os.Build

/** Tiny local state: the paired library id (cached from the `libId` auth claim so
 *  cold start can route instantly) plus a couple of one-shot UI flags. */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("ssx", Context.MODE_PRIVATE)

    var libId: String?
        get() = sp.getString("lib_id", null)
        set(v) { sp.edit().putString("lib_id", v).apply() }

    val isPaired: Boolean
        get() = !libId.isNullOrBlank()

    val deviceName: String
        get() = Build.MODEL ?: "Android"

    fun clear() { sp.edit().clear().apply() }
}
