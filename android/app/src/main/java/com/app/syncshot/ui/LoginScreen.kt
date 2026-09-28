package com.app.syncshot.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.credentials.exceptions.GetCredentialCancellationException
import com.app.syncshot.data.GoogleAuth
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
fun LoginScreen(onSignedIn: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    Box(Modifier.fillMaxSize().safeDrawingPadding().padding(28.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Text("SyncShot", style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold)
            Text("Your Mac and phone, connected.", style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
            Text("Use the same Google account on every device to find your screenshots and copied text.", textAlign = TextAlign.Center)
            Button(enabled = !busy, onClick = {
                busy = true
                error = null
                scope.launch {
                    try {
                        GoogleAuth.signIn(context)
                        onSignedIn()
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: GetCredentialCancellationException) {
                        error = "Sign-in cancelled. You can try again."
                    } catch (failure: Exception) {
                        error = failure.message ?: "Could not sign in. Check your connection and try again."
                    } finally {
                        busy = false
                    }
                }
            }, modifier = Modifier.fillMaxWidth()) {
                Text(if (busy) "Signing in…" else "Continue with Google")
            }
            if (busy) CircularProgressIndicator(Modifier.size(24.dp))
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center) }
            Text("Have an older phone account? Connect Google from Profile before signing out to keep your library.", style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
        }
    }
}
