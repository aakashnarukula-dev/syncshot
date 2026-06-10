package com.app.screenshotx.data

import java.security.MessageDigest

object Hashing {
    fun sha256(bytes: ByteArray): String {
        val md = MessageDigest.getInstance("SHA-256")
        return md.digest(bytes).joinToString("") { "%02x".format(it) }
    }
}
