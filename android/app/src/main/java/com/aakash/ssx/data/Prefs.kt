package com.aakash.ssx.data

import android.content.Context

class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("ssx", Context.MODE_PRIVATE)

    var baseUrl: String?
        get() = sp.getString("base_url", null)
        set(v) { sp.edit().putString("base_url", v).apply() }

    var token: String?
        get() = sp.getString("token", null)
        set(v) { sp.edit().putString("token", v).apply() }

    val isPaired: Boolean
        get() = !baseUrl.isNullOrBlank() && !token.isNullOrBlank()

    fun clear() { sp.edit().clear().apply() }
}
