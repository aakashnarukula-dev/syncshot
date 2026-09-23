package com.app.syncshot.ui

import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AccountCircle
import androidx.compose.material.icons.rounded.CloudUpload
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.app.syncshot.R
import com.app.syncshot.data.FirebaseRepo
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Super-simple shell: same mental model as Mac.
 *   - one realtime screenshot stream, newest first,
 *   - one upload action for manual images,
 *   - profile tucked behind the header icon.
 *  No tabs, no pager, no extra clipboard surface on the home screen. */
@Composable
fun RootScreen(onSignedOut: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()

    var showProfile by remember { mutableStateOf(false) }
    // GalleryScreen raises this when an image is opened; chrome hides while true.
    var viewerOpen by remember { mutableStateOf(false) }

    // The header's upload action: import an image and publish it as a screenshot
    // (same behavior the old gallery "+" had — only the glyph changed).
    val pickMedia = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia()
    ) { uris ->
        if (uris.isNotEmpty()) {
            scope.launch {
                var failures = 0
                for (uri in uris) {
                    val ok = withContext(Dispatchers.IO) {
                        runCatching {
                            val bytes = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                                ?: return@runCatching false
                            FirebaseRepo.publishScreenshot(ctx, bytes); true
                        }.getOrDefault(false)
                    }
                    if (!ok) failures++
                }
                if (failures > 0) {
                    Toast.makeText(ctx, "$failures image(s) failed to upload", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    Scaffold(contentWindowInsets = WindowInsets(0, 0, 0, 0)) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            if (showProfile) {
                ProfileScreen(onSignedOut = onSignedOut, onBack = { showProfile = false })
            } else {
                Column(Modifier.fillMaxSize()) {
                    if (!viewerOpen) {
                        AppHeader(
                            onUpload = {
                                pickMedia.launch(
                                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                                )
                            },
                            onProfile = { showProfile = true },
                        )
                    }
                    Box(Modifier.fillMaxWidth().weight(1f)) {
                        GalleryScreen(onViewerOpenChange = { viewerOpen = it })
                    }
                }
            }
        }
    }
}

/** Top app bar: app logo + compact "SyncShot" title on the left; upload + profile
 *  icon buttons on the right. */
@Composable
private fun AppHeader(onUpload: () -> Unit, onProfile: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Image(
                painter = painterResource(R.mipmap.ic_launcher_foreground),
                contentDescription = null,
                modifier = Modifier.size(26.dp).clip(RoundedCornerShape(6.dp)),
            )
            Spacer(Modifier.width(8.dp))
            Text(
                "SyncShot",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onUpload) {
                Icon(Icons.Rounded.CloudUpload, contentDescription = "Upload screenshot")
            }
            IconButton(onClick = onProfile) {
                Icon(Icons.Rounded.AccountCircle, contentDescription = "Profile")
            }
        }
    }
}
