package com.app.syncshot.data

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import com.app.syncshot.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * "Login with Truecaller", landing on the SAME Firebase account as phone-OTP.
 *
 * This is the Truecaller **web_verify deeplink** flow (not the OAuth SDK): the
 * app POSTs /init for a one-time requestNonce, fires the
 * `truecallersdk://truesdk/web_verify` deeplink at the Truecaller app, and
 * Truecaller's backend posts the verified profile to the server's /callback
 * server-to-server. The SyncShot server (syncshot-server.vercel.app)
 * resolves the same uid as phone-OTP via getUserByPhoneNumber, mints a Firebase
 * custom token, and we pick it up by polling /status?nonce= and feeding it to
 * [FirebaseRepo.signInWithCustomToken]. No partner secret lives in the app; the
 * partnerKey comes from /init (Vercel env), with an optional BuildConfig
 * override (TRUECALLER_PARTNER_KEY gradle property) for local builds.
 */
object TruecallerAuth {
    private const val BASE = "https://syncshot-server.vercel.app"
    private const val DEEPLINK_BASE = "truecallersdk://truesdk/web_verify"
    private const val TIMEOUT_MS = 15_000

    data class Session(val nonce: String, val partnerKey: String, val partnerName: String)

    sealed interface Result {
        data class Success(val customToken: String) : Result
        data object NotInstalled : Result
        data object Rejected : Result
        data class Failed(val reason: String) : Result
    }

    /** POST /init → a fresh requestNonce + the server-configured partner key. */
    suspend fun init(): Session = withContext(Dispatchers.IO) {
        val json = postJson("$BASE/api/truecaller/init", "{}")
        val nonce = json.optString("requestNonce").ifBlank { json.optString("nonce") }
        require(nonce.isNotBlank()) { "init returned no nonce" }
        Session(
            nonce = nonce,
            partnerKey = json.optString("partnerKey", ""),
            partnerName = json.optString("partnerName", "SyncShot"),
        )
    }

    /** The effective partner key: server /init value, else the BuildConfig override. */
    fun resolveKey(session: Session): String =
        session.partnerKey.ifBlank { BuildConfig.TRUECALLER_PARTNER_KEY }

    /** True once a partner key is configured somewhere (so the button can light up). */
    fun isConfigured(session: Session?): Boolean = session != null && resolveKey(session).isNotBlank()

    private fun deeplink(nonce: String, partnerKey: String, partnerName: String): Uri =
        Uri.parse(DEEPLINK_BASE).buildUpon()
            .appendQueryParameter("requestNonce", nonce)
            .appendQueryParameter("partnerKey", partnerKey)
            .appendQueryParameter("partnerName", partnerName)
            .appendQueryParameter("lang", "en")
            .appendQueryParameter("title", "signIn")
            .build()

    /** Fire the Truecaller consent screen. Returns false if Truecaller isn't installed. */
    fun launch(ctx: Context, session: Session): Boolean {
        val key = resolveKey(session)
        if (key.isBlank()) return false
        val intent = Intent(Intent.ACTION_VIEW, deeplink(session.nonce, key, session.partnerName))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            ctx.startActivity(intent)
            true
        } catch (e: ActivityNotFoundException) {
            false
        }
    }

    /** Poll /status until the server has minted the custom token (or the flow ends). */
    suspend fun awaitToken(nonce: String, timeoutMs: Long = 90_000): Result = withContext(Dispatchers.IO) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            delay(1500)
            val json = runCatching { getJson("$BASE/api/truecaller/status?nonce=" + enc(nonce)) }
                .getOrNull() ?: continue
            when (json.optString("status")) {
                "ready" -> {
                    val token = json.optString("customToken")
                    return@withContext if (token.isNotBlank()) Result.Success(token)
                    else Result.Failed("ready_without_token")
                }
                "error" -> return@withContext Result.Rejected
                "expired" -> return@withContext Result.Failed("expired")
                // "pending" / "not_found" → keep polling
            }
        }
        Result.Failed("timeout")
    }

    // --- tiny HTTP helpers (org.json + HttpURLConnection, no extra deps) ---------

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    private fun postJson(url: String, body: String): JSONObject {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = TIMEOUT_MS
            readTimeout = TIMEOUT_MS
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Accept", "application/json")
        }
        conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        return conn.readJson()
    }

    private fun getJson(url: String): JSONObject {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = TIMEOUT_MS
            readTimeout = TIMEOUT_MS
            setRequestProperty("Accept", "application/json")
        }
        return conn.readJson()
    }

    private fun HttpURLConnection.readJson(): JSONObject = try {
        val stream = if (responseCode in 200..299) inputStream else errorStream
        val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        if (text.isBlank()) JSONObject() else JSONObject(text)
    } finally {
        disconnect()
    }
}
