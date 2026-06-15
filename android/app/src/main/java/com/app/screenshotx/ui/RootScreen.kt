package com.app.screenshotx.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier

/** Three-destination bottom nav: ScreenshotX (grid), ClipboardX (list), Profile.
 *  The bottom bar is hidden while the full-screen image viewer is open so the
 *  image truly fills the screen. */
@Composable
fun RootScreen(onSignedOut: () -> Unit) {
    var tab by remember { mutableIntStateOf(0) }
    // The gallery raises this when an image is opened; the nav bar hides while true.
    var viewerOpen by remember { mutableStateOf(false) }

    Scaffold(
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        bottomBar = {
            if (!viewerOpen) {
                NavigationBar {
                    NavigationBarItem(
                        selected = tab == 0,
                        onClick = { tab = 0 },
                        icon = { Icon(Icons.Filled.PhotoLibrary, contentDescription = "ScreenshotX") },
                        label = { Text("ScreenshotX") },
                    )
                    NavigationBarItem(
                        selected = tab == 1,
                        onClick = { tab = 1 },
                        icon = { Icon(Icons.Filled.ContentPaste, contentDescription = "ClipboardX") },
                        label = { Text("ClipboardX") },
                    )
                    NavigationBarItem(
                        selected = tab == 2,
                        onClick = { tab = 2 },
                        icon = { Icon(Icons.Filled.Person, contentDescription = "Profile") },
                        label = { Text("Profile") },
                    )
                }
            }
        },
    ) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            when (tab) {
                0 -> GalleryScreen(onViewerOpenChange = { viewerOpen = it })
                1 -> ClipboardScreen()
                else -> ProfileScreen(onSignedOut = onSignedOut)
            }
        }
    }
}
