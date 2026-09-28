package com.app.syncshot.ui

import android.content.Intent
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.app.syncshot.data.AccountAccess
import com.app.syncshot.sync.SyncService
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

@Composable
fun AccountGate(content: @Composable () -> Unit) {
    val context = LocalContext.current
    var allowed by remember { mutableStateOf(false) }
    var checking by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var retry by remember { mutableStateOf(0) }
    LaunchedEffect(retry) {
        do {
            try {
                allowed = AccountAccess.check()
                error = if (allowed) null else "Your trial has ended. Lifetime access is ₹999 in India or $9 internationally. Checkout is currently a demo and does not activate access."
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) {
                allowed = false
                error = "Could not verify your account. Check your connection and try again."
            } finally { checking = false }
            if (!allowed) context.stopService(Intent(context, SyncService::class.java))
            delay(60_000)
        } while (true)
    }
    if (allowed) content()
    else Box(Modifier.fillMaxSize().safeDrawingPadding().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("Your SyncShot account", style = MaterialTheme.typography.headlineSmall)
            if (checking) CircularProgressIndicator()
            error?.let { Text(it) }
            Button(enabled = !checking, onClick = { checking = true; retry++ }) { Text("Check access again") }
            TextButton(onClick = { com.google.firebase.auth.FirebaseAuth.getInstance().signOut() }) { Text("Sign out") }
        }
    }
}
