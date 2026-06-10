package com.app.screenshotx

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import com.app.screenshotx.data.FirebaseRepo
import com.app.screenshotx.data.Prefs
import com.app.screenshotx.sync.SyncService
import com.app.screenshotx.ui.PairScreen
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
                    var paired by remember { mutableStateOf(Prefs(ctx).isPaired) }
                    var resolved by remember { mutableStateOf(false) }

                    LaunchedEffect(Unit) {
                        FirebaseRepo.ensureSignedIn()
                        paired = FirebaseRepo.currentLibId(ctx) != null
                        resolved = true
                    }
                    LaunchedEffect(paired) { if (paired) SyncService.start(ctx) }

                    when {
                        paired -> RootScreen()
                        !resolved -> Box(Modifier.fillMaxSize()) {
                            CircularProgressIndicator(Modifier.align(Alignment.Center))
                        }
                        else -> PairScreen(onPaired = { paired = true })
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
