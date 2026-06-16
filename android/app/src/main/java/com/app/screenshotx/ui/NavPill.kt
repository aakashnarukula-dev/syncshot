package com.app.screenshotx.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp

/** Compact segmented toggle that replaces the old ScreenshotX/ClipboardX bottom
 *  tabs: a dark rounded pill with two segments — "Screenshots" (image) and
 *  "Text" (clipboard). The active segment sits on a raised, highlighted chip.
 *  Mirrors the macOS app's edge-pill control. Tab 0 = Screenshots, 1 = Text. */
@Composable
fun NavPill(selected: Int, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier
            .clip(RoundedCornerShape(50))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        PillSegment(
            label = "Screenshots",
            icon = Icons.Filled.PhotoLibrary,
            active = selected == 0,
            onClick = { onSelect(0) },
        )
        PillSegment(
            label = "Text",
            icon = Icons.Filled.ContentPaste,
            active = selected == 1,
            onClick = { onSelect(1) },
        )
    }
}

@Composable
private fun PillSegment(label: String, icon: ImageVector, active: Boolean, onClick: () -> Unit) {
    val bg by animateColorAsState(
        if (active) MaterialTheme.colorScheme.surface else androidx.compose.ui.graphics.Color.Transparent,
        label = "pillSegBg",
    )
    val fg by animateColorAsState(
        if (active) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
        label = "pillSegFg",
    )
    Row(
        Modifier
            .clip(RoundedCornerShape(50))
            .background(bg)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick,
            )
            .padding(horizontal = 14.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = label, tint = fg, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(6.dp))
        Text(label, color = fg, style = MaterialTheme.typography.labelLarge)
    }
}
