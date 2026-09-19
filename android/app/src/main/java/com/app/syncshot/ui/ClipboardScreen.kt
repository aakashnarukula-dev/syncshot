package com.app.syncshot.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.text.format.DateUtils
import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import kotlinx.coroutines.delay
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.app.syncshot.data.ClipItem
import com.app.syncshot.data.FirebaseRepo
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch

/** @param embedded true when shown under the shared header + Screenshots|Text pill
 *  (RootScreen) — it then drops its own status-bar inset and "ClipboardX" title to
 *  avoid a duplicate header. Standalone (false) keeps the old self-contained chrome. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ClipboardScreen(embedded: Boolean = false) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()

    var refreshKey by remember { mutableIntStateOf(0) }
    var refreshing by remember { mutableStateOf(false) }
    val clipsFlow = remember(refreshKey) {
        if (FirebaseRepo.signedIn) FirebaseRepo.clipboardSnapshots()
        else flowOf(emptyList<ClipItem>())
    }
    val clips by clipsFlow.collectAsState(initial = emptyList())
    // Pinned first, then newest.
    val sorted = remember(clips) { clips.sortedWith(compareByDescending<ClipItem> { it.pinned }.thenByDescending { it.createdAt }) }

    fun recopy(item: ClipItem) {
        ctx.getSystemService(ClipboardManager::class.java)
            .setPrimaryClip(ClipData.newPlainText("SyncShot", item.text))
        Toast.makeText(ctx, "Copied", Toast.LENGTH_SHORT).show()
    }

    fun syncCurrentClipboard() {
        val clipboard = ctx.getSystemService(ClipboardManager::class.java)
        val text = clipboard.primaryClip
            ?.takeIf { it.itemCount > 0 }
            ?.getItemAt(0)
            ?.coerceToText(ctx)
            ?.toString()
            ?.trim()
        if (text.isNullOrBlank()) {
            Toast.makeText(ctx, "Copy some text first", Toast.LENGTH_SHORT).show()
            return
        }
        scope.launch {
            runCatching { FirebaseRepo.writeClipboard(ctx.applicationContext, text) }
                .onSuccess { Toast.makeText(ctx, "Saved to SyncShot", Toast.LENGTH_SHORT).show() }
                .onFailure { Toast.makeText(ctx, "Couldn't save clipboard", Toast.LENGTH_SHORT).show() }
        }
    }

    Column(Modifier.fillMaxSize().then(if (embedded) Modifier else Modifier.statusBarsPadding())) {
        if (!embedded) {
            Text(
                "ClipboardX",
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.padding(start = 16.dp, top = 8.dp, bottom = 8.dp),
            )
        }

        ClipboardOnboarding(onSyncClipboard = ::syncCurrentClipboard)

        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                refreshing = true
                refreshKey++
                scope.launch { delay(700); refreshing = false }
            },
            modifier = Modifier.fillMaxSize(),
        ) {
            // When embedded under RootScreen, leave room for the floating glass pill
            // (pill height + spacing + gesture inset) so the last row scrolls clear.
            val pillClearance =
                if (embedded) 96.dp + WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
                else 0.dp
            LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 12.dp, top = 12.dp, end = 12.dp, bottom = 12.dp + pillClearance),
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
private fun ClipboardOnboarding(onSyncClipboard: () -> Unit) {
    Card(Modifier.fillMaxWidth().padding(12.dp)) {
        Column(Modifier.padding(16.dp)) {
            Text("Sync text intentionally", style = MaterialTheme.typography.titleSmall)
            Spacer(Modifier.height(4.dp))
            Text(
                "SyncShot never watches other apps. Copy text, then tap “Sync current clipboard”, " +
                    "or choose SyncShot from Android's Share menu.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.End, modifier = Modifier.fillMaxWidth()) {
                TextButton(onClick = onSyncClipboard) { Text("Sync current clipboard") }
            }
        }
    }
}
