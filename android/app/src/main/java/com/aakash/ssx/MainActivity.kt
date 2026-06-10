package com.aakash.ssx

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import com.aakash.ssx.data.Prefs
import com.aakash.ssx.sync.SyncService
import com.aakash.ssx.ui.GalleryScreen
import com.aakash.ssx.ui.PairScreen
import com.aakash.ssx.ui.theme.SsxTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            SsxTheme {
                Surface(modifier = Modifier) {
                    RequestPermissions()
                    val ctx = LocalContext.current
                    val prefs = remember { Prefs(ctx) }
                    var paired by remember { mutableStateOf(prefs.isPaired) }
                    if (paired) {
                        LaunchedEffect(Unit) { SyncService.start(ctx) }
                        GalleryScreen()
                    } else {
                        PairScreen(onPaired = { paired = true })
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
