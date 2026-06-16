package com.app.screenshotx.ui

import android.text.format.DateUtils
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.Laptop
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Smartphone
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.app.screenshotx.data.DeviceDoc
import com.app.screenshotx.data.FirebaseRepo
import com.app.screenshotx.data.Prefs
import com.app.screenshotx.data.db.AppDb
import com.app.screenshotx.sync.SyncService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Account screen: the signed-in phone number, the other devices on this account
 *  (each remotely sign-out-able), and sign-out for this device. The header logout
 *  used to live in the gallery/clipboard top bars — it now lives only here. */
@Composable
fun ProfileScreen(onSignedOut: () -> Unit, onBack: (() -> Unit)? = null) {
    if (onBack != null) BackHandler(onBack = onBack)
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val myDeviceId = remember { Prefs(ctx).deviceId }
    val phone = remember { FirebaseRepo.phoneNumber }

    val devices by produceState(initialValue = emptyList<DeviceDoc>(), Unit) {
        if (!FirebaseRepo.signedIn) return@produceState
        FirebaseRepo.deviceSnapshots().collect { value = it }
    }
    val others = remember(devices) { devices.filter { it.id != myDeviceId } }

    var confirmSignOut by remember { mutableStateOf(false) }
    var confirmRevoke by remember { mutableStateOf<DeviceDoc?>(null) }

    if (confirmSignOut) AlertDialog(
        onDismissRequest = { confirmSignOut = false },
        title = { Text("Sign out?") },
        text = { Text("Stops syncing on this device. Sign back in anytime with the same number.") },
        confirmButton = {
            TextButton(onClick = {
                confirmSignOut = false
                scope.launch {
                    withContext(Dispatchers.IO) {
                        runCatching { FirebaseRepo.signOutLocal(ctx) }
                        runCatching { AppDb.get(ctx).clearAllTables() }
                    }
                    runCatching { ctx.stopService(android.content.Intent(ctx, SyncService::class.java)) }
                    onSignedOut()
                }
            }) { Text("Sign out", color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(onClick = { confirmSignOut = false }) { Text("Cancel") } },
    )

    confirmRevoke?.let { dev ->
        AlertDialog(
            onDismissRequest = { confirmRevoke = null },
            title = { Text("Log out ${dev.name}?") },
            text = { Text("That device stops syncing and has to sign in again to regain access.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmRevoke = null
                    scope.launch {
                        val ok = withContext(Dispatchers.IO) {
                            runCatching { FirebaseRepo.revokeDevice(dev.id) }.isSuccess
                        }
                        Toast.makeText(
                            ctx,
                            if (ok) "${dev.name} logged out" else "Couldn't log out device",
                            Toast.LENGTH_SHORT,
                        ).show()
                    }
                }) { Text("Log out", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmRevoke = null }) { Text("Cancel") } },
        )
    }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        Row(
            Modifier.fillMaxWidth().padding(start = 4.dp, top = 8.dp, bottom = 8.dp, end = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (onBack != null) {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                }
            } else {
                Spacer(Modifier.size(12.dp))
            }
            Text("Profile", style = MaterialTheme.typography.titleLarge)
        }

        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                start = 12.dp, end = 12.dp, bottom = 12.dp,
            ),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item {
                Card(Modifier.fillMaxWidth()) {
                    Row(
                        Modifier.padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Filled.Phone, null, tint = MaterialTheme.colorScheme.primary)
                        Spacer(Modifier.size(14.dp))
                        Column {
                            Text("Signed in as", style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(
                                phone ?: "This account",
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                    }
                }
            }

            item {
                Text(
                    "This device",
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = 4.dp, top = 8.dp),
                )
            }
            item {
                DeviceRow(
                    name = "${Prefs(ctx).deviceName} (this device)",
                    subtitle = phone ?: "Active now",
                    icon = Icons.Filled.Smartphone,
                    actionLabel = "Sign out",
                    onAction = { confirmSignOut = true },
                )
            }

            if (others.isNotEmpty()) {
                item {
                    Text(
                        "Other devices",
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = 4.dp, top = 8.dp),
                    )
                }
                items(others, key = { it.id }) { dev ->
                    DeviceRow(
                        name = dev.name,
                        subtitle = if (dev.lastSeenAt > 0)
                            "Last active ${DateUtils.getRelativeTimeSpanString(dev.lastSeenAt)}"
                        else dev.platform.ifBlank { "Paired device" },
                        icon = if (dev.platform.contains("mac", true) ||
                            dev.platform.contains("darwin", true)) Icons.Filled.Laptop
                        else Icons.Filled.Smartphone,
                        actionLabel = "Log out",
                        onAction = { confirmRevoke = dev },
                    )
                }
            } else {
                item {
                    Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                        Text(
                            "No other devices signed in.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun DeviceRow(
    name: String,
    subtitle: String,
    icon: ImageVector,
    actionLabel: String,
    onAction: () -> Unit,
) {
    Card(Modifier.fillMaxWidth()) {
        Row(
            Modifier.padding(start = 14.dp, top = 8.dp, bottom = 8.dp, end = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(icon, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.size(14.dp))
            Column(Modifier.weight(1f)) {
                Text(name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                Spacer(Modifier.height(2.dp))
                Text(
                    subtitle,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            OutlinedButton(onClick = onAction) {
                Icon(
                    Icons.AutoMirrored.Filled.Logout,
                    null,
                    modifier = Modifier.size(18.dp),
                    tint = MaterialTheme.colorScheme.error,
                )
                Spacer(Modifier.size(6.dp))
                Text(actionLabel, color = MaterialTheme.colorScheme.error)
            }
        }
    }
}
