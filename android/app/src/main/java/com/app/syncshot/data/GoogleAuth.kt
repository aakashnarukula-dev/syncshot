package com.app.syncshot.data

import android.content.Context
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.ClearCredentialStateRequest
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.firebase.Firebase
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.auth.auth
import kotlinx.coroutines.tasks.await

object GoogleAuth {
    suspend fun signIn(context: Context) {
        if (Firebase.auth.currentUser?.providerData?.any { it.providerId == "google.com" } == true) return
        val resource = context.resources.getIdentifier("default_web_client_id", "string", context.packageName)
        check(resource != 0) { "Google sign-in is not configured in this build. Install the latest release or contact support." }
        val clientId = context.getString(resource)
        check(clientId.isNotBlank()) { "Google sign-in is not configured in this build." }
        val option = GetSignInWithGoogleOption.Builder(clientId).build()
        val response = CredentialManager.create(context).getCredential(
            context, GetCredentialRequest.Builder().addCredentialOption(option).build(),
        )
        val credential = response.credential
        check(credential is CustomCredential && credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
            "Google did not return a sign-in credential. Please try again."
        }
        val token = GoogleIdTokenCredential.createFrom(credential.data).idToken
        val firebaseCredential = GoogleAuthProvider.getCredential(token, null)
        val current = Firebase.auth.currentUser
        if (current != null && !current.isAnonymous && current.providerData.none { it.providerId == "google.com" }) {
            // Preserve the phone account UID and its entire library. Never silently merge users.
            current.linkWithCredential(firebaseCredential).await()
        } else {
            Firebase.auth.signInWithCredential(firebaseCredential).await()
        }
    }

    suspend fun clear(context: Context) {
        CredentialManager.create(context).clearCredentialState(ClearCredentialStateRequest())
    }
}
