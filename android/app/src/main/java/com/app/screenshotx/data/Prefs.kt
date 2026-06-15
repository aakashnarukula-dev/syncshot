package com.app.screenshotx.data

import android.content.Context
import android.os.Build
import java.util.UUID

/** Tiny local state: a stable per-install device id (all devices share one auth
 *  uid, so docs are told apart by deviceId) and the device display name. */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("ssx", Context.MODE_PRIVATE)

    val deviceId: String
        get() = sp.getString("device_id", null) ?: UUID.randomUUID().toString()
            .also { sp.edit().putString("device_id", it).apply() }

    val deviceName: String
        get() = Build.MODEL ?: "Android"

    fun clear() { sp.edit().clear().apply() }
}
