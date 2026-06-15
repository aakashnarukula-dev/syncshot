package com.app.screenshotx.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.provider.Settings
import android.text.format.DateUtils
import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import kotlinx.coroutines.delay
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.app.screenshotx.data.ClipItem
import com.app.screenshotx.data.FirebaseRepo
import com.app.screenshotx.sync.ClipboardCaptureService
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ClipboardScreen() {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val lifecycleOwner = LocalLifecycleOwner.current

    var captureEnabled by remember { mutableStateOf(ClipboardCaptureService.isEnabled(ctx)) }
    DisposableEffect(lifecycleOwner) {
        val obs = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                captureEnabled = ClipboardCaptureService.isEnabled(ctx)
            }
        }
        lifecycleOwner.lifecycle.addObserver(obs)
        onDispose { lifecycleOwner.lifecycle.removeObserver(obs) }
    }

    var refreshKey by remember { mutableIntStateOf(0) }
    var refreshing by remember { mutableStateOf(false) }
    val clips by produceState(initialValue = emptyList<ClipItem>(), refreshKey) {
        if (!FirebaseRepo.signedIn) return@produceState
        FirebaseRepo.clipboardSnapshots().collect { value = it }
    }
    // Pinned first, then newest.
    val sorted = remember(clips) { clips.sortedWith(compareByDescending<ClipItem> { it.pinned }.thenByDescending { it.createdAt }) }

    fun recopy(item: ClipItem) {
        ctx.getSystemService(ClipboardManager::class.java)
            .setPrimaryClip(ClipData.newPlainText("ScreenshotX", item.text))
        Toast.makeText(ctx, "Copied", Toast.LENGTH_SHORT).show()
    }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        Text(
            "ClipboardX",
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.padding(start = 16.dp, top = 8.dp, bottom = 8.dp),
        )

        if (!captureEnabled) {
            CaptureOnboarding {
                ctx.startActivity(
                    Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }
        }

        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                refreshing = true
                refreshKey++
                scope.launch { delay(700); refreshing = false }
            },
            modifier = Modifier.fillMaxSize(),
        ) {
            LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (sorted.isEmpty()) {
                    item {
                        Box(
                            Modifier.fillMaxWidth().padding(top = 80.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                "Copied text from your devices shows up here.",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                } else {
                    items(sorted, key = { it.id }) { item ->
                        ClipRow(
                            item = item,
                            onCopy = { recopy(item) },
                            onPin = { scope.launch { runCatching { FirebaseRepo.setClipPinned(item.id, !item.pinned) } } },
                            onDelete = { scope.launch { runCatching { FirebaseRepo.deleteClip(item.id) } } },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ClipRow(item: ClipItem, onCopy: () -> Unit, onPin: () -> Unit, onDelete: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable { onCopy() }) {
        Row(
            Modifier.padding(start = 14.dp, top = 10.dp, bottom = 10.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    item.text,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    buildString {
                        append(DateUtils.getRelativeTimeSpanString(item.createdAt))
                        if (item.deviceName.isNotBlank()) append(" · ${item.deviceName}")
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = onPin) {
                Icon(
                    if (item.pinned) Icons.Filled.PushPin else Icons.Outlined.PushPin,
                    if (item.pinned) "Unpin" else "Pin",
                    tint = if (item.pinned) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = onDelete) {
                Icon(Icons.Filled.Delete, "Delete", tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun CaptureOnboarding(onEnable: () -> Unit) {
    Card(Modifier.fillMaxWidth().padding(12.dp)) {
        Column(Modifier.padding(16.dp)) {
            Text("Enable background capture", style = MaterialTheme.typography.titleSmall)
            Spacer(Modifier.height(4.dp))
            Text(
                "To sync text you copy on this phone, turn on the ScreenshotX accessibility service. " +
                    "It only reads the clipboard when you copy.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.End, modifier = Modifier.fillMaxWidth()) {
                TextButton(onClick = onEnable) { Text("Open settings") }
            }
        }
    }
}
