package com.app.screenshotx.ui

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
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
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
import com.app.screenshotx.R
import com.app.screenshotx.data.FirebaseRepo
import dev.chrisbanes.haze.HazeState
import dev.chrisbanes.haze.hazeSource
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

    // Two horizontally-swipeable pages: 0 = Screenshots grid, 1 = Text/clipboard list.
    // pagerState is the single source of truth for the selected view: swiping moves the
    // pager and the pill highlight follows pagerState.currentPage; tapping a pill segment
    // animates the pager to that page. No separate "tab" state to keep in sync.
    val pagerState = rememberPagerState(pageCount = { 2 })
    var showProfile by remember { mutableStateOf(false) }
    // GalleryScreen raises this when an image is opened; chrome hides while true.
    var viewerOpen by remember { mutableStateOf(false) }
    // Backdrop source for the floating glass pill: the scrolling content registers
    // as the haze source; the pill samples it (blurred on API 31+).
    val hazeState = remember { HazeState() }

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
                        // Swipeable content fills the area and scrolls *behind* the floating
                        // pill. It registers as the haze backdrop source the pill samples.
                        // While the full-screen image viewer is open we disable horizontal
                        // scroll so the root pager can't steal the viewer's own swipe gestures.
                        HorizontalPager(
                            state = pagerState,
                            userScrollEnabled = !viewerOpen,
                            modifier = Modifier.fillMaxSize().hazeSource(hazeState),
                        ) { page ->
                            when (page) {
                                0 -> GalleryScreen(onViewerOpenChange = { viewerOpen = it })
                                else -> ClipboardScreen(embedded = true)
                            }
                        }
                        // Floating glass toggle, pinned bottom-center above the gesture inset.
                        // Highlight follows the swipe (currentPage); a tap animates the pager.
                        if (!viewerOpen) {
                            NavPill(
                                selected = pagerState.currentPage,
                                onSelect = { scope.launch { pagerState.animateScrollToPage(it) } },
                                hazeState = hazeState,
                                modifier = Modifier
                                    .align(Alignment.BottomCenter)
                                    .windowInsetsPadding(WindowInsets.navigationBars)
                                    .padding(bottom = 18.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

/** Top app bar: app logo + compact "ScreenshotX" title on the left; upload + profile
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
                "ScreenshotX",
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
