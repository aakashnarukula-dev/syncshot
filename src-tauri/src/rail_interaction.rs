//! Mouse interaction for the floating rail while another app has keyboard focus.

use objc2_app_kit::{NSTrackingArea, NSTrackingAreaOptions, NSView};
use objc2_foundation::{NSDictionary, NSString};
use objc2_modern::{runtime::AnyObject, AnyThread};

const TRACKING_MARKER: &str = "SyncShotInactiveRailTracking";

fn inactive_tracking_options(options: NSTrackingAreaOptions) -> NSTrackingAreaOptions {
    let activity = NSTrackingAreaOptions::ActiveWhenFirstResponder
        | NSTrackingAreaOptions::ActiveInKeyWindow
        | NSTrackingAreaOptions::ActiveInActiveApp;
    (options & !activity) | NSTrackingAreaOptions::ActiveAlways
}

/// Keep WebKit's existing event owner and public tracking-area contract. Modern
/// WebKit routes hover through a separate observer, so an area owned by the
/// WKWebView itself would not deliver hover to the page.
///
/// An additional ActiveAlways area supplies inactive-window events without
/// replacing WebKit-owned areas (which WebKit can rebuild itself). The marker
/// makes repeated show/resize calls idempotent and lets normal windows opt out.
pub fn configure(window: &tauri::WebviewWindow, enabled: bool) -> tauri::Result<()> {
    window.with_webview(move |webview| unsafe {
        // Tauri guarantees that this closure runs on the AppKit main thread.
        let view = &*webview.inner().cast::<NSView>();
        let marker = NSString::from_str(TRACKING_MARKER);
        let marker_object: &AnyObject = &marker;
        for area in view.trackingAreas().to_vec() {
            if area
                .userInfo()
                .is_some_and(|info| info.objectForKey(marker_object).is_some())
            {
                view.removeTrackingArea(&area);
            }
        }
        if !enabled {
            return;
        }

        if let Some(native_window) = view.window() {
            native_window.setAcceptsMouseMovedEvents(true);
            // Set the receiving view without making the window key or
            // activating SyncShot. acceptFirstMouse remains enabled in config.
            native_window.makeFirstResponder(Some(view));
        }

        for original in view.trackingAreas().to_vec() {
            let options = original.options();
            if !options.contains(NSTrackingAreaOptions::MouseMoved)
                || options.contains(NSTrackingAreaOptions::ActiveAlways)
            {
                continue;
            }
            let Some(owner) = original.owner() else {
                continue;
            };
            let info =
                NSDictionary::<NSString, AnyObject>::from_slices(&[&*marker], &[marker_object]);
            // Objective-C dictionary generics are erased at runtime; every
            // NSString key is also an AnyObject, as required by userInfo.
            let info = &*(&*info as *const NSDictionary<NSString, AnyObject>
                as *const NSDictionary<AnyObject, AnyObject>);
            let area = NSTrackingArea::initWithRect_options_owner_userInfo(
                NSTrackingArea::alloc(),
                original.rect(),
                inactive_tracking_options(options),
                Some(&owner),
                Some(info),
            );
            view.addTrackingArea(&area);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inactive_tracking_keeps_geometry_and_events_but_removes_focus_requirement() {
        let input = NSTrackingAreaOptions::MouseMoved
            | NSTrackingAreaOptions::MouseEnteredAndExited
            | NSTrackingAreaOptions::InVisibleRect
            | NSTrackingAreaOptions::ActiveInKeyWindow;
        let output = inactive_tracking_options(input);
        assert!(output.contains(NSTrackingAreaOptions::ActiveAlways));
        assert!(!output.contains(NSTrackingAreaOptions::ActiveInKeyWindow));
        assert!(output.contains(NSTrackingAreaOptions::InVisibleRect));
        assert!(output.contains(NSTrackingAreaOptions::MouseMoved));
        assert!(output.contains(NSTrackingAreaOptions::MouseEnteredAndExited));
    }
}
