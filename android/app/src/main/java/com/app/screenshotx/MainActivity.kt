package com.app.screenshotx

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import com.app.screenshotx.data.FirebaseRepo
import com.app.screenshotx.sync.SyncService
import com.app.screenshotx.ui.LoginScreen
import com.app.screenshotx.ui.RootScreen
import com.app.screenshotx.ui.theme.SsxTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            SsxTheme {
                Surface(Modifier.fillMaxSize()) {
                    RequestPermissions()
                    val ctx = LocalContext.current
                    // Auth state is read synchronously from the persisted session;
                    // pre-OTP anonymous sessions are discarded.
                    var signedIn by remember { mutableStateOf(FirebaseRepo.purgeAnonymousAndCheck()) }

                    LaunchedEffect(signedIn) { if (signedIn) SyncService.start(ctx) }

                    if (signedIn) {
                        RootScreen(onSignedOut = { signedIn = false })
                    } else {
                        LoginScreen(onSignedIn = { signedIn = true })
                    }
                }
            }
        }
    }
}

@Composable
private fun RequestPermissions() {
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {}
    LaunchedEffect(Unit) {
        val perms = buildList {
            if (Build.VERSION.SDK_INT >= 33) {
                add(Manifest.permission.READ_MEDIA_IMAGES)
                add(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                add(Manifest.permission.READ_EXTERNAL_STORAGE)
            }
        }
        launcher.launch(perms.toTypedArray())
    }
}
