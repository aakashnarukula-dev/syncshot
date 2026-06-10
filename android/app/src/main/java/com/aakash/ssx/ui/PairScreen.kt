package com.aakash.ssx.ui

import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.aakash.ssx.data.HubClient
import com.aakash.ssx.data.Prefs
import com.aakash.ssx.sync.Fcm
import com.aakash.ssx.sync.SyncService
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun PairScreen(onPaired: () -> Unit) {
    val ctx = LocalContext.current
    var url by remember { mutableStateOf("https://screenshotx.gyftalala.com") }
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents ?: return@rememberLauncherForActivityResult
        val uri = runCatching { Uri.parse(contents) }.getOrNull()
        if (uri != null && uri.scheme == "ssx" && uri.host == "pair") {
            uri.getQueryParameter("url")?.let { url = it }
            uri.getQueryParameter("code")?.let { code = it.uppercase() }
        } else {
            error = "Unrecognized QR code"
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("ScreenshotX", style = MaterialTheme.typography.headlineMedium)
        Text(
            "Pair this phone with your hub.\nGet a code on the hub, then enter it here.",
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
        )
        OutlinedTextField(
            value = url,
            onValueChange = { url = it },
            label = { Text("Hub URL") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = code,
            onValueChange = { code = it },
            label = { Text("Pairing code") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
            modifier = Modifier.fillMaxWidth(),
        )
        if (error != null) {
            Text(error!!, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
        }
        OutlinedButton(
            onClick = {
                error = null
                scanLauncher.launch(
                    ScanOptions()
                        .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                        .setPrompt("Scan the pairing QR on your hub")
                        .setBeepEnabled(false)
                        .setOrientationLocked(false)
                )
            },
            enabled = !busy,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Scan QR")
        }
        Button(
            onClick = {
                busy = true
                error = null
                scope.launch {
                    try {
                        val base = url.trim().trimEnd('/')
                        val token = withContext(Dispatchers.IO) {
                            HubClient.claim(base, code.trim().uppercase(), Build.MODEL ?: "Android")
                        }
                        Prefs(ctx).apply { baseUrl = base; this.token = token }
                        SyncService.start(ctx)
                        Fcm.registerCurrentToken(ctx)  // best-effort, no-op without Firebase
                        onPaired()
                    } catch (e: Exception) {
                        error = e.message ?: "Pairing failed"
                    } finally {
                        busy = false
                    }
                }
            },
            enabled = !busy && code.isNotBlank() && url.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (busy) {
                CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
            } else {
                Text("Pair")
            }
        }
    }
}
