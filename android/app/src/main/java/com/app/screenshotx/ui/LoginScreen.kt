package com.app.screenshotx.ui

import android.app.Activity
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import com.app.screenshotx.data.FirebaseRepo
import com.app.screenshotx.data.TruecallerAuth
import kotlinx.coroutines.launch

private const val CODE_LENGTH = 6

/** Phone OTP sign-in: enter number -> SMS code -> done. Same number on every
 *  device = same library. */
@Composable
fun LoginScreen(onSignedIn: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()

    var phone by remember { mutableStateOf("") }
    var codeSent by remember { mutableStateOf(false) }
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    // Truecaller: probe /init once to learn whether a partner key is configured;
    // the button stays greyed out until it is (and we don't crash without it).
    var tcSession by remember { mutableStateOf<TruecallerAuth.Session?>(null) }
    var tcChecked by remember { mutableStateOf(false) }
    var tcBusy by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        runCatching { TruecallerAuth.init() }.onSuccess { tcSession = it }
        tcChecked = true
    }

    fun loginWithTruecaller() {
        val activity = ctx as? Activity ?: return
        if (busy || tcBusy) return
        scope.launch {
            tcBusy = true
            error = null
            // A fresh nonce per attempt (the probe nonce may be stale/consumed).
            val session = runCatching { TruecallerAuth.init() }.getOrNull()
            if (session == null) {
                error = "Couldn't reach Truecaller. Try again."; tcBusy = false; return@launch
            }
            tcSession = session
            if (!TruecallerAuth.isConfigured(session)) {
                error = "Truecaller sign-in isn't available yet."; tcBusy = false; return@launch
            }
            if (!TruecallerAuth.launch(activity, session)) {
                error = "Install the Truecaller app to sign in this way."; tcBusy = false; return@launch
            }
            when (val r = TruecallerAuth.awaitToken(session.nonce)) {
                is TruecallerAuth.Result.Success ->
                    runCatching { FirebaseRepo.signInWithCustomToken(r.customToken) }
                        .onSuccess { onSignedIn() }
                        .onFailure { error = it.message ?: "Sign-in failed"; tcBusy = false }
                TruecallerAuth.Result.NotInstalled -> {
                    error = "Install the Truecaller app to sign in this way."; tcBusy = false
                }
                TruecallerAuth.Result.Rejected -> {
                    error = "Truecaller sign-in was cancelled."; tcBusy = false
                }
                is TruecallerAuth.Result.Failed -> {
                    error = "Truecaller sign-in timed out. Try again."; tcBusy = false
                }
            }
        }
    }

    fun sendCode() {
        val activity = ctx as? Activity ?: return
        val digits = phone.filter(Char::isDigit)
        if (digits.length != 10) {
            error = "Enter your 10-digit mobile number"
            return
        }
        val number = "+91$digits"
        busy = true
        error = null
        FirebaseRepo.sendPhoneOtp(
            activity = activity,
            phone = number,
            onSent = { busy = false; codeSent = true; code = "" },
            onAutoSignedIn = { onSignedIn() },
            onError = { busy = false; error = it.message ?: "Couldn't send the code" },
        )
    }

    fun verify(c: String) {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            runCatching { FirebaseRepo.signInWithOtp(c) }
                .onSuccess { onSignedIn() }
                .onFailure {
                    error = it.message ?: "Sign-in failed"
                    code = ""
                    busy = false
                }
        }
    }

    LaunchedEffect(code) {
        if (code.length == CODE_LENGTH && !busy) verify(code)
    }

    Column(
        modifier = Modifier.fillMaxSize().imePadding().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("ScreenshotX", style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(8.dp))
        Text(
            if (codeSent) "Enter the 6-digit code we texted to +91 $phone."
            else "Sign in with your phone — we'll text a 6-digit code.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(28.dp))

        if (!codeSent) {
            OutlinedTextField(
                value = phone,
                onValueChange = { raw -> phone = raw.filter(Char::isDigit).take(10) },
                enabled = !busy,
                singleLine = true,
                label = { Text("Phone number") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(20.dp))
            if (busy) {
                CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
            } else {
                Button(
                    onClick = { sendCode() },
                    enabled = phone.length == 10,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Send code") }
            }
        } else {
            CodeBoxes(code = code, enabled = !busy, onChange = { code = it })
            Spacer(Modifier.height(20.dp))
            if (busy) {
                CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
            } else {
                TextButton(onClick = { sendCode() }) { Text("Resend code") }
                TextButton(onClick = { codeSent = false; code = ""; error = null }) {
                    Text("Change number")
                }
            }
        }

        // "Login with Truecaller" — one tap = same Firebase account as phone-OTP.
        // Only offered on the initial screen, before an SMS code is in flight.
        if (!codeSent) {
            Spacer(Modifier.height(20.dp))
            if (tcBusy) {
                CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
            } else {
                OutlinedButton(
                    onClick = { loginWithTruecaller() },
                    enabled = tcChecked && TruecallerAuth.isConfigured(tcSession) && !busy,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Login with Truecaller") }
                if (tcChecked && !TruecallerAuth.isConfigured(tcSession)) {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "Truecaller sign-in isn't available yet.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                }
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
