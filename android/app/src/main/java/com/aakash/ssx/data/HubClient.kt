package com.aakash.ssx.data

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

class HubClient(private val baseUrl: String, private val token: String?) {

    private val http = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private fun Request.Builder.authed(): Request.Builder {
        if (token != null) header("Authorization", "Bearer $token")
        return this
    }

    fun catalog(since: Double = 0.0): List<CatalogItem> {
        val req = Request.Builder().url("$baseUrl/api/catalog?since=$since").authed().build()
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("catalog ${resp.code}")
            val arr = JSONObject(resp.body!!.string()).getJSONArray("screenshots")
            return (0 until arr.length()).map { CatalogItem.fromJson(arr.getJSONObject(it)) }
        }
    }

    fun uploadBytes(data: ByteArray, hash: String, filename: String, origin: String): Boolean {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("sha256", hash)
            .addFormDataPart("origin_device", origin)
            .addFormDataPart("created_at", (System.currentTimeMillis() / 1000.0).toString())
            .addFormDataPart("filename", filename)
            .addFormDataPart("file", filename, data.toRequestBody("image/png".toMediaType()))
            .build()
        val req = Request.Builder().url("$baseUrl/api/upload").post(body).authed().build()
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("upload ${resp.code}")
            return JSONObject(resp.body!!.string()).optBoolean("new")
        }
    }

    fun downloadImage(hash: String): ByteArray {
        val req = Request.Builder().url(imageUrl(hash)).authed().build()
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("image ${resp.code}")
            return resp.body!!.bytes()
        }
    }

    fun registerFcmToken(token: String) {
        val payload = JSONObject().put("fcm_token", token).toString()
            .toRequestBody("application/json".toMediaType())
        val req = Request.Builder().url("$baseUrl/api/device/fcm").post(payload).authed().build()
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("fcm register ${resp.code}")
        }
    }

    fun imageUrl(hash: String) = "$baseUrl/api/image/$hash"
    fun thumbUrl(hash: String, w: Int = 320) = "$baseUrl/api/thumb/$hash?w=$w"

    fun openEvents(onNew: (String) -> Unit): WebSocket {
        val url = baseUrl.replace("https://", "wss://").replace("http://", "ws://") +
            "/events?token=$token"
        val req = Request.Builder().url(url).build()
        return http.newWebSocket(req, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                val o = JSONObject(text)
                if (o.optString("type") == "new") onNew(o.getString("hash"))
            }
        })
    }

    companion object {
        fun claim(baseUrl: String, code: String, deviceName: String): String {
            val http = OkHttpClient()
            val payload = JSONObject()
                .put("code", code)
                .put("device_name", deviceName)
                .put("platform", "android")
                .toString()
                .toRequestBody("application/json".toMediaType())
            val req = Request.Builder().url("$baseUrl/api/pair/claim").post(payload).build()
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) throw IOException("pairing failed (${resp.code})")
                return JSONObject(resp.body!!.string()).getString("device_token")
            }
        }
    }
}
