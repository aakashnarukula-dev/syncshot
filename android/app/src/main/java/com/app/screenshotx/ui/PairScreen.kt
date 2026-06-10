package com.app.screenshotx.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.app.screenshotx.data.FirebaseRepo
import kotlinx.coroutines.launch

private const val CODE_LENGTH = 6

@Composable
fun PairScreen(onPaired: () -> Unit) {
    val ctx = LocalContext.current
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var scanning by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    fun redeem(c: String) {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            runCatching { FirebaseRepo.redeemPairingCode(ctx, c) }
                .onSuccess { onPaired() }
                .onFailure {
                    error = it.message ?: "Pairing failed"
                    code = ""
                    busy = false
                }
        }
    }

    fun createLibrary() {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            runCatching { FirebaseRepo.createLibrary(ctx) }
                .onSuccess { onPaired() }
                .onFailure {
                    error = it.message ?: "Couldn't create library"
                    busy = false
                }
        }
    }

    LaunchedEffect(code) {
        if (code.length == CODE_LENGTH && !busy) redeem(code)
    }

    val cameraPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted -> if (granted) scanning = true else error = "Camera permission needed to scan" }

    if (scanning) {
        Box(Modifier.fillMaxSize()) {
            QrScanner(
                onResult = { raw ->
                    val digits = raw.filter(Char::isDigit).take(CODE_LENGTH)
                    scanning = false
                    if (digits.length == CODE_LENGTH) redeem(digits)
                    else error = "Unrecognized QR code"
                },
                modifier = Modifier.fillMaxSize(),
            )
            IconButton(
                onClick = { scanning = false },
                modifier = Modifier.align(Alignment.TopStart).padding(8.dp),
            ) { Icon(Icons.Filled.Close, "Close", tint = Color.White) }
        }
        return
    }

    Column(
        modifier = Modifier.fillMaxSize().imePadding().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("ScreenshotX", style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(8.dp))
        Text(
            "Enter the 6-digit code from another device, or scan its QR.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(40.dp))
        CodeBoxes(code = code, enabled = !busy, onChange = { code = it })

        Spacer(Modifier.height(20.dp))
        if (busy) {
            CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
        } else {
            Text(
                "Scan QR",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier
                    .clickable {
                        error = null
                        val granted = ContextCompat.checkSelfPermission(
                            ctx, Manifest.permission.CAMERA
                        ) == PackageManager.PERMISSION_GRANTED
                        if (granted) scanning = true
                        else cameraPermission.launch(Manifest.permission.CAMERA)
                    }
                    .padding(8.dp),
            )
            Spacer(Modifier.height(24.dp))
            OutlinedButton(onClick = { createLibrary() }) {
                Text("Start a new library")
            }
        }

        if (error != null) {
            Spacer(Modifier.height(12.dp))
            Text(
                error!!,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun CodeBoxes(code: String, enabled: Boolean, onChange: (String) -> Unit) {
    val focusRequester = remember { FocusRequester() }
    BasicTextField(
        value = code,
        onValueChange = { raw -> onChange(raw.filter(Char::isDigit).take(CODE_LENGTH)) },
        enabled = enabled,
        singleLine = true,
        textStyle = TextStyle(color = Color.Transparent),
        cursorBrush = SolidColor(Color.Transparent),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        modifier = Modifier.focusRequester(focusRequester),
        decorationBox = {
            Row {
                repeat(CODE_LENGTH) { i ->
                    val ch = code.getOrNull(i)
                    val isCursor = i == code.length && enabled
                    Box(
                        Modifier
                            .padding(horizontal = 5.dp)
                            .size(width = 46.dp, height = 56.dp)
                            .border(
                                width = if (isCursor) 2.dp else 1.dp,
                                color = if (isCursor) MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.outline,
                                shape = RoundedCornerShape(10.dp),
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = ch?.toString() ?: "",
                            style = MaterialTheme.typography.headlineSmall,
                            color = MaterialTheme.colorScheme.onBackground,
                        )
                    }
                }
            }
        },
    )
    LaunchedEffect(Unit) { focusRequester.requestFocus() }
}
