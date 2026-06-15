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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
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

private enum class Phase { PROBING, TRUECALLER, OTP }

/**
 * Truecaller-first sign-in: on open we auto-launch "Login with Truecaller"; if
 * it isn't available or the user backs out, we fall back to phone-OTP in a
 * bottom sheet. Either path lands on the same Firebase account (the server maps
 * phone -> uid), so the library is identical.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LoginScreen(onSignedIn: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()

    var phase by remember { mutableStateOf(Phase.PROBING) }
    var tcConfigured by remember { mutableStateOf(false) }
    var fallbackHint by remember { mutableStateOf<String?>(null) }
    var sheetOpen by remember { mutableStateOf(false) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    fun toOtp(hint: String?) {
        fallbackHint = hint
        phase = Phase.OTP
        sheetOpen = true
    }

    fun runTruecaller(session: TruecallerAuth.Session) {
        val activity = ctx as? Activity ?: return toOtp(null)
        phase = Phase.TRUECALLER
        scope.launch {
            if (!TruecallerAuth.launch(activity, session)) {
                toOtp("Truecaller isn't installed — sign in with your phone.")
                return@launch
            }
            when (val r = TruecallerAuth.awaitToken(session.nonce)) {
                is TruecallerAuth.Result.Success ->
                    runCatching { FirebaseRepo.signInWithCustomToken(r.customToken) }
                        .onSuccess { onSignedIn() }
                        .onFailure { toOtp("Couldn't finish Truecaller sign-in.") }
                // Rejected / timeout / not-installed / failed -> quietly drop to OTP.
                else -> toOtp(null)
            }
        }
    }

    fun startTruecaller() {
        phase = Phase.PROBING
        scope.launch {
            val s = runCatching { TruecallerAuth.init() }.getOrNull()
            if (s != null && TruecallerAuth.isConfigured(s)) {
                tcConfigured = true
                runTruecaller(s)
            } else {
                tcConfigured = false
                toOtp(null)
            }
        }
    }

    // Kick off Truecaller the moment the login screen appears.
    LaunchedEffect(Unit) { startTruecaller() }

    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                "ScreenshotX",
                style = MaterialTheme.typography.displaySmall,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.height(12.dp))
            when (phase) {
                Phase.PROBING, Phase.TRUECALLER -> {
                    Text(
                        "Signing you in with Truecaller…",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                    Spacer(Modifier.height(22.dp))
                    CircularProgressIndicator(Modifier.size(26.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.height(22.dp))
                    TextButton(onClick = { toOtp(null) }) { Text("Use phone number instead") }
                }
                Phase.OTP -> {
                    Text(
                        "Sign in to sync your screenshots.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                    Spacer(Modifier.height(22.dp))
                    Button(
                        onClick = { sheetOpen = true },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Sign in with phone") }
                    if (tcConfigured) {
                        Spacer(Modifier.height(8.dp))
                        TextButton(onClick = { startTruecaller() }) { Text("Try Truecaller again") }
                    }
                }
            }
        }
    }

    if (sheetOpen) {
        ModalBottomSheet(
            onDismissRequest = { sheetOpen = false },
            sheetState = sheetState,
        ) {
            PhoneOtpContent(hint = fallbackHint, onSignedIn = onSignedIn)
        }
    }
}

/** Phone-OTP sign-in (the fallback): enter number -> SMS code -> done. Rendered
 *  inside the bottom sheet. Same number on every device = same library. */
@Composable
private fun PhoneOtpContent(hint: String?, onSignedIn: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()

    var phone by remember { mutableStateOf("") }
    var codeSent by remember { mutableStateOf(false) }
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

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
        modifier = Modifier
            .fillMaxWidth()
            .imePadding()
            .navigationBarsPadding()
            .padding(start = 24.dp, end = 24.dp, bottom = 28.dp, top = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            if (codeSent) "Enter the code" else "Sign in with your phone",
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold,
        )
        Spacer(Modifier.height(6.dp))
        Text(
            when {
                codeSent -> "Enter the 6-digit code we texted to +91 $phone."
                hint != null -> hint
                else -> "We'll text you a 6-digit code."
            },
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(24.dp))

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
