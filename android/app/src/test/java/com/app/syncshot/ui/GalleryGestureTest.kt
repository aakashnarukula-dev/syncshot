package com.app.syncshot.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GalleryGestureTest {
    @Test
    fun finger_jitter_stays_a_tap_for_zoom_toggle() {
        assertTrue(completedGestureIsTap(maxPointers = 1, maxTravel = 7f, touchSlop = 8f))
    }

    @Test
    fun pan_and_pinch_do_not_trigger_zoom_toggle() {
        assertFalse(completedGestureIsTap(maxPointers = 1, maxTravel = 9f, touchSlop = 8f))
        assertFalse(completedGestureIsTap(maxPointers = 2, maxTravel = 0f, touchSlop = 8f))
    }
}
