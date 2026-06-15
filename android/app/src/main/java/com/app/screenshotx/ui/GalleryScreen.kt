package com.app.screenshotx.ui

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.snapshotFlow
import androidx.paging.Pager
import androidx.paging.PagingConfig
import androidx.paging.compose.collectAsLazyPagingItems
import androidx.paging.compose.itemKey
import coil.compose.AsyncImage
import coil.compose.AsyncImagePainter
import coil.request.ImageRequest
import android.content.Context
import android.content.Intent
import com.app.screenshotx.data.FirebaseRepo
import com.app.screenshotx.data.ScreenshotPaging
import com.app.screenshotx.data.db.AppDb
import com.app.screenshotx.data.db.ScreenshotEntity
import com.app.screenshotx.sync.SyncService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.math.abs

/** A real on-disk copy of this shot, if one exists — the received/<sha>.png that
 *  the capturing device cached or another device's full download, or the viewer's
 *  shared cache. Lets a brand-new shot render instantly instead of waiting on a
 *  Storage round-trip (which leaves the tile a grey placeholder). */
private fun localFile(ctx: Context, sha: String): File? {
    val recv = File(File(ctx.filesDir, "received"), "$sha.png")
    if (recv.exists() && recv.length() > 0L) return recv
    val shared = File(File(ctx.cacheDir, "shared"), "$sha.png")
    if (shared.exists() && shared.length() > 0L) return shared
    return null
}

/** Best available source for a tile/viewer: local file first, then the Storage
 *  thumb, then the full. Returns null only while the upload still lags (no thumb,
 *  no full, no local) — the tile shows a spinner and re-binds when the doc flips
 *  to status "thumb"/"full" (Room upsert → Paging invalidation → recompose). */
private fun imageModel(ctx: Context, item: ScreenshotEntity, local: File?, preferFull: Boolean): ImageRequest? {
    val b = ImageRequest.Builder(ctx).crossfade(true)
    if (local != null) {
        return b.data(local).memoryCacheKey("${item.sha256}:l").diskCacheKey("${item.sha256}:l").build()
    }
    val first = if (preferFull) item.fullPath else item.thumbPath
    val second = if (preferFull) item.thumbPath else item.fullPath
    val suffix = if (preferFull) ":f" else ":t"
    if (!first.isNullOrBlank())
        return b.data(FirebaseRepo.storageRef(first)).memoryCacheKey("${item.sha256}$suffix")
            .diskCacheKey("${item.sha256}$suffix").build()
    if (!second.isNullOrBlank())
        return b.data(FirebaseRepo.storageRef(second)).memoryCacheKey("${item.sha256}:any")
            .diskCacheKey("${item.sha256}:any").build()
    return null
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GalleryScreen(onViewerOpenChange: (Boolean) -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val pager = remember {
        Pager(PagingConfig(pageSize = 60, enablePlaceholders = false)) {
            AppDb.get(ctx).screenshots().pagingSource()
        }
    }
    val shots = pager.flow.collectAsLazyPagingItems()
    var selected by remember { mutableStateOf<ScreenshotEntity?>(null) }
    val gridState = rememberLazyGridState()
    var refreshing by remember { mutableStateOf(false) }

    // Keep the host (RootScreen) in sync so it can hide the bottom nav while the
    // image viewer is open.
    LaunchedEffect(selected) { onViewerOpenChange(selected != null) }

    // Lazy-load: each time the user scrolls into the last rows, pull the next
    // Firestore page (SyncService grows the listener; Room/Paging picks it up).
    LaunchedEffect(gridState) {
        snapshotFlow {
            val info = gridState.layoutInfo
            val total = info.totalItemsCount
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: 0
            total > 0 && last >= total - 8
        }.distinctUntilChanged().collect { nearEnd -> if (nearEnd) ScreenshotPaging.loadMore() }
    }

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

    AnimatedContent(
        targetState = selected,
        transitionSpec = { fadeIn(tween(220)) togetherWith fadeOut(tween(220)) },
        label = "viewer",
    ) { sel ->
        if (sel == null) {
            Column(Modifier.fillMaxSize().statusBarsPadding()) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("ScreenshotX", style = MaterialTheme.typography.titleLarge)
                    IconButton(onClick = {
                        pickMedia.launch(
                            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                        )
                    }) { Icon(Icons.Filled.Add, "Add image") }
                }

                PullToRefreshBox(
                    isRefreshing = refreshing,
                    onRefresh = {
                        refreshing = true
                        ScreenshotPaging.reset()
                        shots.refresh()
                        scope.launch { delay(700); refreshing = false }
                    },
                    modifier = Modifier.fillMaxSize(),
                ) {
                    LazyVerticalGrid(
                        state = gridState,
                        columns = GridCells.Adaptive(110.dp),
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(10.dp),
                    ) {
                        if (shots.itemCount == 0) {
                            item(span = { GridItemSpan(maxLineSpan) }) {
                                Box(
                                    Modifier.fillMaxWidth().padding(top = 80.dp),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        "No screenshots yet.\nTake one on any paired device.",
                                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        } else {
                            items(count = shots.itemCount, key = shots.itemKey { it.id }) { index ->
                                val item = shots[index] ?: return@items
                                GalleryTile(ctx = ctx, item = item, onClick = { selected = item })
                            }
                        }
                    }
                }
            }
        } else {
            FullScreenViewer(
                items = shots.itemSnapshotList.items,
                startIndex = shots.itemSnapshotList.items.indexOfFirst { it.id == sel.id }.coerceAtLeast(0),
                onClose = { selected = null },
            )
        }
    }
}

/** One grid tile. Shows a brief loading spinner over the surface until the image
 *  resolves, so a just-captured shot never sits as a dead grey placeholder. */
@Composable
private fun GalleryTile(ctx: Context, item: ScreenshotEntity, onClick: () -> Unit) {
    // Prefer the local file. If it isn't there yet (a synced shot still downloading,
    // or a just-captured one mid-write), keep checking briefly so the tile switches
    // to the local image rather than staying stuck on a slow/missing network thumb.
    val local by produceState<File?>(
        localFile(ctx, item.sha256), item.id, item.thumbPath, item.fullPath,
    ) {
        if (value == null) repeat(12) {
            delay(500)
            localFile(ctx, item.sha256)?.let { value = it; return@produceState }
        }
    }
    val model = remember(item.id, item.thumbPath, item.fullPath, local) {
        imageModel(ctx, item, local, preferFull = false)
    }
    // Spinner only while actively loading. Error (e.g. a 404 from a blob deleted on
    // the cloud) settles to the grey surface instead of spinning forever.
    var loading by remember(item.id, item.thumbPath, item.fullPath, local) { mutableStateOf(model != null) }
    Box(
        Modifier
            .padding(4.dp)
            .aspectRatio(1f)
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .clickable(onClick = onClick),
    ) {
        AsyncImage(
            model = model,
            contentDescription = item.sha256,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize(),
            onState = { state ->
                loading = state is AsyncImagePainter.State.Loading ||
                    state is AsyncImagePainter.State.Empty && model != null
            },
        )
        if (loading) {
            CircularProgressIndicator(
                modifier = Modifier.align(Alignment.Center).size(22.dp),
                strokeWidth = 2.dp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun FullScreenViewer(
    items: List<ScreenshotEntity>,
    startIndex: Int,
    onClose: () -> Unit,
) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    if (items.isEmpty()) { onClose(); return }
    val pagerState = rememberPagerState(initialPage = startIndex.coerceIn(0, items.size - 1)) { items.size }
    var pagerScrollEnabled by remember { mutableStateOf(true) }
    var dismissY by remember { mutableFloatStateOf(0f) }
    val bgAlpha = (1f - (abs(dismissY) / 1200f)).coerceIn(0f, 1f)
    val current = items.getOrNull(pagerState.currentPage)
    var confirmDelete by remember { mutableStateOf(false) }

    BackHandler { onClose() }

    if (confirmDelete) AlertDialog(
        onDismissRequest = { confirmDelete = false },
        title = { Text("Delete screenshot?") },
        text = { Text("Removes it from this device and every paired device. This can't be undone.") },
        confirmButton = {
            TextButton(onClick = {
                confirmDelete = false
                val item = current ?: return@TextButton
                scope.launch {
                    val ok = withContext(Dispatchers.IO) {
                        runCatching { ImageActions.deleteEverywhere(ctx, item) }.isSuccess
                    }
                    Toast.makeText(
                        ctx,
                        if (ok) "Deleted" else "Delete failed",
                        Toast.LENGTH_SHORT,
                    ).show()
                }
            }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
    )

    Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = bgAlpha))) {
        HorizontalPager(
            state = pagerState,
            userScrollEnabled = pagerScrollEnabled,
            key = { items[it].id },
            modifier = Modifier.fillMaxSize(),
        ) { page ->
            val item = items[page]
            var scale by remember(item.id) { mutableFloatStateOf(1f) }
            var pan by remember(item.id) { mutableStateOf(Offset.Zero) }
            val isCurrent = page == pagerState.currentPage
            val model = remember(item.id, item.thumbPath, item.fullPath) {
                imageModel(ctx, item, localFile(ctx, item.sha256), preferFull = true)
            }
            AsyncImage(
                model = model,
                contentDescription = item.sha256,
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .fillMaxSize()
                    .graphicsLayer {
                        scaleX = scale
                        scaleY = scale
                        translationX = pan.x
                        translationY = pan.y + (if (isCurrent) dismissY else 0f)
                    }
                    .pointerInput(item.id) {
                        awaitEachGesture {
                            awaitFirstDown(requireUnconsumed = false)
                            do {
                                val event = awaitPointerEvent()
                                val zoom = event.calculateZoom()
                                val panChange = event.calculatePan()
                                if (zoom != 1f) {
                                    scale = (scale * zoom).coerceIn(1f, 4f)
                                    pagerScrollEnabled = scale <= 1f
                                }
                                if (scale > 1f) {
                                    pan += panChange
                                    event.changes.forEach { if (it.positionChanged()) it.consume() }
                                } else if (abs(panChange.y) > abs(panChange.x)) {
                                    dismissY += panChange.y
                                }
                            } while (event.changes.any { it.pressed })
                            if (scale <= 1f) {
                                pan = Offset.Zero
                                pagerScrollEnabled = true
                                if (dismissY > 300f) onClose() else dismissY = 0f
                            }
                        }
                    },
            )
        }

        Row(
            Modifier.fillMaxWidth().align(Alignment.TopStart).statusBarsPadding().padding(8.dp),
        ) {
            PressIcon(Icons.AutoMirrored.Filled.ArrowBack, "Back", onClose)
        }

        // Google-Photos-style bottom action bar; fades out with the
        // swipe-to-dismiss backdrop.
        Row(
            Modifier
                .fillMaxWidth()
                .align(Alignment.BottomCenter)
                .graphicsLayer { alpha = bgAlpha }
                .navigationBarsPadding()
                .padding(bottom = 12.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            BottomAction(Icons.Filled.Share, "Share") {
                val item = current ?: return@BottomAction
                val path = item.fullPath ?: return@BottomAction
                scope.launch {
                    val f = withContext(Dispatchers.IO) {
                        runCatching { ImageActions.ensureFile(ctx, item.sha256, path) }.getOrNull()
                    }
                    if (f != null) ImageActions.share(ctx, f)
                    else Toast.makeText(ctx, "Couldn't load image", Toast.LENGTH_SHORT).show()
                }
            }
            BottomAction(Icons.Filled.Download, "Save") {
                val item = current ?: return@BottomAction
                val path = item.fullPath ?: return@BottomAction
                scope.launch {
                    val ok = withContext(Dispatchers.IO) {
                        runCatching {
                            ImageActions.saveToGallery(ctx, ImageActions.ensureFile(ctx, item.sha256, path))
                        }.getOrDefault(false)
                    }
                    Toast.makeText(
                        ctx,
                        if (ok) "Saved to Pictures/ScreenshotX" else "Save failed",
                        Toast.LENGTH_SHORT,
                    ).show()
                }
            }
            BottomAction(Icons.Outlined.Delete, "Delete") {
                if (current != null) confirmDelete = true
            }
        }
    }
}

@Composable
private fun BottomAction(icon: ImageVector, label: String, onClick: () -> Unit) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .clip(RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 24.dp, vertical = 8.dp),
    ) {
        Icon(icon, label, tint = Color.White)
        Spacer(Modifier.height(4.dp))
        Text(label, color = Color.White, style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun PressIcon(icon: ImageVector, desc: String, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.8f else 1f, label = "press")
    IconButton(onClick = onClick, interactionSource = interaction, modifier = Modifier.scale(scale)) {
        Icon(icon, desc, tint = Color.White)
    }
}
