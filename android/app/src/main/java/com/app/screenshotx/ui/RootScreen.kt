package com.app.screenshotx.ui

import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.FileUpload
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.app.screenshotx.data.FirebaseRepo
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** App shell. The old 3-tab bottom nav is gone. Now:
 *   - a single header (title + upload action + profile icon button),
 *   - a compact "Screenshots | Text" pill toggle under the header that swaps the
 *     screenshots grid for the clipboard/text list,
 *   - Profile is reached from the header icon (a pushed full screen, not a tab).
 *  The header + pill hide while the full-screen image viewer is open so the image
 *  truly fills the screen (incl. behind the system bars). */
@Composable
fun RootScreen(onSignedOut: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()

    // 0 = Screenshots grid, 1 = Text/clipboard list.
    var tab by remember { mutableIntStateOf(0) }
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
                        NavPill(
                            selected = tab,
                            onSelect = { tab = it },
                            modifier = Modifier
                                .align(Alignment.CenterHorizontally)
                                .padding(bottom = 8.dp),
                        )
                    }
                    Box(Modifier.fillMaxWidth().weight(1f)) {
                        when (tab) {
                            0 -> GalleryScreen(onViewerOpenChange = { viewerOpen = it })
                            else -> ClipboardScreen(embedded = true)
                        }
                    }
                }
            }
        }
    }
}

/** Top app bar: "ScreenshotX" on the left; upload + profile icon buttons on the right. */
@Composable
private fun AppHeader(onUpload: () -> Unit, onProfile: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("ScreenshotX", style = MaterialTheme.typography.titleLarge)
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onUpload) {
                Icon(Icons.Filled.FileUpload, contentDescription = "Upload screenshot")
            }
            IconButton(onClick = onProfile) {
                Icon(Icons.Filled.Person, contentDescription = "Profile")
            }
        }
    }
}
