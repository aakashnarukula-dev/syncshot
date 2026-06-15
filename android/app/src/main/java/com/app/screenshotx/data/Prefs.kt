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

    /** High-water-mark for received-screenshot notifications: the newest
     *  `createdAt` (epoch millis) we've already handled. -1 = not yet initialized
     *  for this account. On the first authoritative snapshot after (re)login it's
     *  set to the newest existing doc so the whole backlog counts as already-seen
     *  (no notification flood); afterwards only docs newer than it notify. Cleared
     *  on sign-out via [clear]. */
    var screenshotHighWater: Long
        get() = sp.getLong("ss_high_water", -1L)
        set(v) { sp.edit().putLong("ss_high_water", v).apply() }

    fun clear() { sp.edit().clear().apply() }
}
