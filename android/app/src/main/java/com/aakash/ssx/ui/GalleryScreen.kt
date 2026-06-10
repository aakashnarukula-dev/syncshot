package com.aakash.ssx.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.aakash.ssx.data.CatalogItem
import com.aakash.ssx.data.HubClient
import com.aakash.ssx.data.Prefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GalleryScreen() {
    val ctx = LocalContext.current
    val prefs = remember { Prefs(ctx) }
    val client = remember { HubClient(prefs.baseUrl ?: "", prefs.token) }
    var items by remember { mutableStateOf<List<CatalogItem>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun refresh() {
        loading = true
        error = null
        scope.launch {
            try {
                items = withContext(Dispatchers.IO) { client.catalog() }
            } catch (e: Exception) {
                error = e.message ?: "Couldn't reach hub"
            } finally {
                loading = false
            }
        }
    }

    LaunchedEffect(Unit) { refresh() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("ScreenshotX") },
                actions = { TextButton(onClick = { refresh() }) { Text("Refresh") } },
            )
        },
    ) { pad ->
        Box(Modifier.padding(pad).fillMaxSize()) {
            when {
                loading && items.isEmpty() ->
                    CircularProgressIndicator(Modifier.align(Alignment.Center))

                error != null && items.isEmpty() ->
                    Text(
                        "Couldn't reach the hub.\n$error",
                        Modifier.align(Alignment.Center).padding(24.dp),
                        textAlign = TextAlign.Center,
                        color = MaterialTheme.colorScheme.error,
                    )

                items.isEmpty() ->
                    Text(
                        "No screenshots yet.\nTake one on any device.",
                        Modifier.align(Alignment.Center).padding(24.dp),
                        textAlign = TextAlign.Center,
                    )

                else -> LazyVerticalGrid(
                    columns = GridCells.Adaptive(110.dp),
                    contentPadding = PaddingValues(10.dp),
                ) {
                    items(items, key = { it.hash }) { item ->
                        AsyncImage(
                            model = client.thumbUrl(item.hash),
                            contentDescription = item.filename,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier
                                .padding(4.dp)
                                .aspectRatio(0.75f)
                                .clip(RoundedCornerShape(12.dp)),
                        )
                    }
                }
            }
        }
    }
}
