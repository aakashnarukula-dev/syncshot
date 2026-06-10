package com.aakash.ssx.data

import org.json.JSONObject

data class CatalogItem(
    val hash: String,
    val filename: String,
    val origin: String,
    val size: Long,
    val createdAt: Double,
) {
    companion object {
        fun fromJson(o: JSONObject) = CatalogItem(
            hash = o.getString("hash"),
            filename = o.optString("filename"),
            origin = o.optString("origin"),
            size = o.optLong("size"),
            createdAt = o.optDouble("created_at"),
        )
    }
}
