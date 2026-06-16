package com.app.screenshotx.ui

import android.os.Build
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.chrisbanes.haze.HazeState
import dev.chrisbanes.haze.hazeEffect
import dev.chrisbanes.haze.materials.ExperimentalHazeMaterialsApi
import dev.chrisbanes.haze.materials.HazeMaterials

/** Floating "Screenshots | Text" toggle — a translucent iOS-26 "liquid glass"
 *  capsule that floats at the bottom-center over the scrolling content. On API 31+
 *  it renders a real backdrop blur (Haze samples the [hazeState] source layer); on
 *  older devices it degrades to a tasteful semi-transparent tinted capsule. The
 *  active segment sits on a slightly more opaque chip so it stays readable on glass.
 *  Tab 0 = Screenshots, 1 = Text. Behavior is unchanged from the old top pill. */
@OptIn(ExperimentalHazeMaterialsApi::class)
@Composable
fun NavPill(
    selected: Int,
    onSelect: (Int) -> Unit,
    hazeState: HazeState,
    modifier: Modifier = Modifier,
) {
    val shape = CircleShape
    // Real RenderEffect backdrop blur is API 31+. Below that, Haze can't blur, so we
    // paint a clean translucent tint instead of a broken/opaque surface.
    val supportsBlur = Build.VERSION.SDK_INT >= 31
    Row(
        modifier
            .shadow(elevation = 12.dp, shape = shape, clip = false)
            .clip(shape)
            .then(
                if (supportsBlur) {
                    Modifier.hazeEffect(state = hazeState, style = HazeMaterials.ultraThin())
                } else {
                    Modifier.background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.86f))
                }
            )
            .border(width = 1.dp, color = Color.White.copy(alpha = 0.18f), shape = shape)
            .padding(5.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        PillSegment(label = "Screenshots", active = selected == 0, onClick = { onSelect(0) })
        PillSegment(label = "Text", active = selected == 1, onClick = { onSelect(1) })
    }
}

@Composable
private fun PillSegment(label: String, active: Boolean, onClick: () -> Unit) {
    // A subtle white chip behind the active segment keeps it legible on the glass.
    val bg by animateColorAsState(
        if (active) Color.White.copy(alpha = 0.22f) else Color.Transparent,
        label = "pillSegBg",
    )
    val fg by animateColorAsState(
        if (active) Color.White else Color.White.copy(alpha = 0.66f),
        label = "pillSegFg",
    )
    Text(
        text = label,
        color = fg,
        style = MaterialTheme.typography.labelLarge,
        modifier = Modifier
            .clip(CircleShape)
            .background(bg)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick,
            )
            .semantics {
                contentDescription = label
                this.selected = active
            }
            .padding(horizontal = 18.dp, vertical = 9.dp),
    )
}
