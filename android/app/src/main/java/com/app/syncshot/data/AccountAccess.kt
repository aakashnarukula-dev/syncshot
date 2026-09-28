package com.app.syncshot.data

import com.google.firebase.Firebase
import com.google.firebase.functions.functions
import kotlinx.coroutines.tasks.await

object AccountAccess {
    suspend fun check(): Boolean {
        if (!FirebaseRepo.signedIn) return false
        val data = Firebase.functions.getHttpsCallable("getAccess").call().await().getData() as? Map<*, *>
        return data?.get("state") == "licensed" || data?.get("state") == "trial"
    }
    suspend fun requireActive() {
        check(check()) { "Your trial has ended. Open SyncShot to review your account access." }
    }
}
