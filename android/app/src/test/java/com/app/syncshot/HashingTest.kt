package com.app.syncshot

import com.app.syncshot.data.Hashing
import org.junit.Assert.assertEquals
import org.junit.Test

class HashingTest {
    @Test
    fun sha256_known_vector() {
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            Hashing.sha256("abc".toByteArray()),
        )
    }
}
