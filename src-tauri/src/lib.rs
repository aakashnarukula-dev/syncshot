//! SyncShot - A screenshot capture and editing application
//!
//! This crate provides the Tauri backend for capturing, editing,
//! and saving screenshots with various features like region selection
//! and background customization.

mod auth;
mod clipboard;
mod commands;
mod image;
mod license;
mod screenshot;
mod utils;

use commands::{
    capture_all_monitors, capture_once, capture_region, copy_to_clipboard, cursor_display_bounds,
    delete_file,
    download_synced_image, get_desktop_directory, get_desktop_root, get_mouse_position,
    file_exists, get_screenshot_thumbnail, get_screenshot_thumbnail_path, get_temp_directory,
    list_screenshots, native_capture_fullscreen, native_capture_interactive,
    read_image_bytes, stat_file, take_editor_pending_path,
    native_capture_window, open_editor_window, play_screenshot_sound, save_edited_image,
    save_edited_image_bytes,
    rename_screenshot_to_doc_id, save_native_screenshot, set_clipboard_text,
};
use auth::{browser_auth_listen, close_auth_window};
use license::{get_machine_id, keychain_delete, keychain_get, keychain_set};

/// Port for the release-mode localhost server (see tauri_plugin_localhost below).
const LOCALHOST_PORT: u16 = 38217;

/// Shared state so the native tray menu (which does NOT rebuild on open) can be
/// rebuilt at any time to reflect the latest auth AND window-visibility state.
/// The last menu item toggles: window visible → "Quit", window hidden → "Open App".
struct TrayState {
    signed_in: std::sync::atomic::AtomicBool,
    window_visible: std::sync::atomic::AtomicBool,
}

/// Build the tray menu for the given auth + visibility state.
/// When the window is VISIBLE, "Quit" (hides the window) is the trailing item:
/// - signed IN  → Preferences, Log Out, sep, Quit
/// - signed OUT → Sign in & Sync, Preferences, sep, Quit
/// When the window is HIDDEN, "Open App" (shows+focuses the window) is at the TOP,
/// followed by a separator then the rest:
/// - signed IN  → Open App, sep, Preferences, Log Out
/// - signed OUT → Open App, sep, Sign in & Sync, Preferences
fn build_tray_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    signed_in: bool,
    window_visible: bool,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
    let preferences_item = MenuItemBuilder::with_id("preferences", "Preferences…").build(app)?;
    let sep = PredefinedMenuItem::separator(app)?;
    if window_visible {
        // Window visible: the trailing item is "Quit" (hides the window).
        let quit_item = MenuItemBuilder::with_id("quit", "Quit")
            .accelerator("CommandOrControl+Q")
            .build(app)?;
        if signed_in {
            let logout_item = MenuItemBuilder::with_id("logout", "Log Out").build(app)?;
            MenuBuilder::new(app)
                .items(&[&preferences_item, &logout_item, &sep, &quit_item])
                .build()
        } else {
            let library_item = MenuItemBuilder::with_id("library", "Sign in & Sync").build(app)?;
            MenuBuilder::new(app)
                .items(&[&library_item, &preferences_item, &sep, &quit_item])
                .build()
        }
    } else {
        // Window hidden: "Open App" goes to the TOP, then a separator, then the rest.
        let open_item = MenuItemBuilder::with_id("open", "Open App").build(app)?;
        if signed_in {
            let logout_item = MenuItemBuilder::with_id("logout", "Log Out").build(app)?;
            MenuBuilder::new(app)
                .items(&[&open_item, &sep, &preferences_item, &logout_item])
                .build()
        } else {
            let library_item = MenuItemBuilder::with_id("library", "Sign in & Sync").build(app)?;
            MenuBuilder::new(app)
                .items(&[&open_item, &sep, &library_item, &preferences_item])
                .build()
        }
    }
}

/// Rebuild + set the tray menu from the CURRENT `TrayState` (both auth and
/// window-visibility). Call this whenever either changes so the native menu
/// stays in sync (it does not rebuild itself on open).
fn refresh_tray_menu(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    use tauri::Manager;
    let state = app.state::<TrayState>();
    let signed_in = state.signed_in.load(Ordering::Relaxed);
    let window_visible = state.window_visible.load(Ordering::Relaxed);
    match build_tray_menu(app, signed_in, window_visible) {
        Ok(menu) => {
            if let Some(tray) = app.tray_by_id("main") {
                if let Err(e) = tray.set_menu(Some(menu)) {
                    eprintln!("Failed to set tray menu: {}", e);
                }
            }
        }
        Err(e) => eprintln!("Failed to build tray menu: {}", e),
    }
}

/// Bridge: the webview calls this whenever auth state resolves/changes so the
/// tray menu reflects signed-in vs signed-out (see build_tray_menu). Preserves
/// the current window-visibility state.
#[tauri::command]
fn update_tray_menu(app: tauri::AppHandle, signed_in: bool) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    use tauri::Manager;
    app.state::<TrayState>()
        .signed_in
        .store(signed_in, Ordering::Relaxed);
    refresh_tray_menu(&app);
    Ok(())
}

/// macOS: make `window` visible on EVERY Space (and able to float over another
/// app's fullscreen) by setting its NSWindow `collectionBehavior`. This is what
/// turns the edge "pill" rail into a system-overlay-style window that follows
/// you between desktops instead of living on the single Space it opened on.
///
/// `collectionBehavior` is an NSUInteger bitmask (NSWindowCollectionBehavior):
///   CanJoinAllSpaces    (1<<0) — show on whichever Space is active
///   Stationary          (1<<4) — don't shuffle position in Mission Control/Exposé
///   FullScreenAuxiliary  (1<<8) — allowed to appear over a fullscreen app's Space
///
/// `enable = false` restores normal single-Space, managed behavior — used when
/// the SHARED main window expands into the decorated Library/Preferences view
/// (same NSWindow, different geometry) so that view behaves like a normal window.
///
/// Does NOT touch window level, focus, or activation, so the single-instance
/// guard and key/main-window handling are unaffected.
#[cfg(target_os = "macos")]
fn apply_all_spaces_behavior(window: &tauri::WebviewWindow, enable: bool) -> Result<(), String> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    const CAN_JOIN_ALL_SPACES: usize = 1 << 0;
    const MANAGED: usize = 1 << 2;
    const STATIONARY: usize = 1 << 4;
    const PARTICIPATES_IN_CYCLE: usize = 1 << 5;
    const FULLSCREEN_AUXILIARY: usize = 1 << 8;

    let ns_window = window
        .ns_window()
        .map_err(|e| format!("ns_window handle: {}", e))? as *mut AnyObject;
    if ns_window.is_null() {
        return Err("ns_window handle is null".to_string());
    }

    let behavior: usize = if enable {
        CAN_JOIN_ALL_SPACES | STATIONARY | FULLSCREEN_AUXILIARY
    } else {
        // Default macOS behavior for a normal app window.
        MANAGED | PARTICIPATES_IN_CYCLE
    };

    unsafe {
        let _: () = msg_send![ns_window, setCollectionBehavior: behavior];
    }
    Ok(())
}

/// Toggle whether the main (pill/rail) window appears on all Spaces + over
/// fullscreen apps. The pill and the Library/Preferences view are the SAME
/// NSWindow remorphed by the frontend, so the frontend should call this with
/// `false` when it expands into Library/Preferences and `true` when it collapses
/// back to the edge pill. No-op on non-macOS.
#[tauri::command]
fn set_pill_all_spaces(app: tauri::AppHandle, enable: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        match app.get_webview_window("main") {
            Some(window) => apply_all_spaces_behavior(&window, enable),
            None => Err("main window not found".to_string()),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, enable);
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Must be the FIRST plugin registered. Stops a second instance (e.g. the
    // login-item autostart plus a manual launch) from booting — otherwise each
    // instance registers the same global shortcut and opens its own thumbnail
    // column, so one keypress spawns multiple columns.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Emitter;
            // A second launch (e.g. double-click in Finder while already running)
            // asks the running instance to resurface the thumbnail column. The
            // frontend decides expanded vs collapsed and positions it correctly.
            let _ = app.emit("surface-column", ());
        }));
    }

    builder
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_screenshots::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_drag::init())
        // Serve the bundled frontend over real localhost HTTP in release.
        // Firebase phone-auth's reCAPTCHA rejects tokens minted on the custom
        // tauri:// origin; http://localhost is an authorized domain.
        .plugin(tauri_plugin_localhost::Builder::new(LOCALHOST_PORT).build())
        .setup(|app| {
            use tauri::Manager;
            use tauri_plugin_autostart::ManagerExt;

            // Track auth + window visibility so the native tray menu (which does
            // not rebuild on open) can be rebuilt whenever either changes. The
            // window starts visible and signed-out.
            app.manage(TrayState {
                signed_in: false.into(),
                window_visible: true.into(),
            });

            // Release only: dev keeps the Vite devUrl (already http://localhost:1420).
            #[cfg(not(debug_assertions))]
            if let Some(window) = app.get_webview_window("main") {
                let url = format!("http://localhost:{LOCALHOST_PORT}")
                    .parse()
                    .expect("valid localhost url");
                if let Err(e) = window.navigate(url) {
                    eprintln!("Failed to navigate main window to localhost: {}", e);
                }
            }

            // Accessory (not Regular) so the app runs as a menu-bar / tray-only
            // app: no Dock icon and no Cmd+Tab entry, like an LSUIElement app.
            // The persistent tray icon and hide-to-tray behavior make the Dock
            // icon redundant. Windows can still show()/set_focus() (the frontend
            // does this for the always-on-top overlay), so the main window still
            // appears at startup.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Launch at login automatically (idempotent if already enabled).
            if let Err(e) = app.autolaunch().enable() {
                eprintln!("Failed to enable autostart: {}", e);
            }

            // Start the clipboard watcher: polls NSPasteboard.changeCount and
            // emits `clipboard-changed` so the webview can sync copies.
            crate::clipboard::start_clipboard_watcher(app.handle().clone());

            // Thumbnail backfill: one LOW-PRIORITY pass ~5s after launch that
            // generates every missing cache thumbnail, so any later rail open
            // over the whole library is a 100% cache hit instead of a cold
            // decode storm. Own OS thread (not the tokio pool): the pass
            // sleeps/yields for minutes and must never occupy a runtime
            // worker. Serial, and starved by interactive requests by design.
            std::thread::spawn(|| {
                std::thread::sleep(std::time::Duration::from_secs(5));
                match crate::utils::get_syncshot_dir() {
                    Ok(dir) => {
                        let (generated, skipped, failed) = crate::image::backfill_thumbnails(
                            &dir,
                            crate::image::BACKFILL_THUMB_MAX_PX,
                        );
                        eprintln!(
                            "[thumb-backfill] pass complete: {generated} generated, {skipped} already cached, {failed} failed"
                        );
                    }
                    Err(e) => eprintln!("[thumb-backfill] skipped: {e}"),
                }
            });

            if let Some(window) = app.get_webview_window("main") {
                let window_clone = window.clone();
                let event_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    use std::sync::atomic::Ordering;
                    match event {
                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            // "Close" (✕) hides the window instead of terminating;
                            // reflect the hidden state so the tray shows "Open App".
                            if let Err(e) = window_clone.hide() {
                                eprintln!("Failed to hide window: {}", e);
                            }
                            api.prevent_close();
                            event_handle
                                .state::<TrayState>()
                                .window_visible
                                .store(false, Ordering::Relaxed);
                            refresh_tray_menu(&event_handle);
                        }
                        // The frontend shows the window (Preferences / dock-click /
                        // second-instance) via show()+setFocus(), which fires
                        // Focused(true). Sync the tray to "Quit". Ignore
                        // Focused(false): a visible window can lose focus.
                        tauri::WindowEvent::Focused(true) => {
                            event_handle
                                .state::<TrayState>()
                                .window_visible
                                .store(true, Ordering::Relaxed);
                            refresh_tray_menu(&event_handle);
                        }
                        _ => {}
                    }
                });
            }

            // Make the edge "pill" rail appear on every macOS Space (and over
            // fullscreen apps) so it acts like a system overlay rather than
            // living on the single Space it opened on. The pill is the `main`
            // window; the frontend can later flip this off via the
            // `set_pill_all_spaces` command when it expands into Library/Prefs.
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = apply_all_spaces_behavior(&window, true) {
                    eprintln!("Failed to set all-Spaces behavior on pill window: {}", e);
                }
            }

            // Pre-warm the singleton editor window (hidden) so the first
            // "edit" click doesn't pay the full webview + React boot (~1-3s).
            // Delayed a few seconds to keep launch itself snappy; the cost is
            // roughly one idle webview of extra RSS. Skipped if an open beat
            // the timer and already built it.
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    let app_handle = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        if app_handle
                            .get_webview_window(commands::EDITOR_WINDOW_LABEL)
                            .is_none()
                        {
                            if let Err(e) = commands::build_editor_window(&app_handle, false) {
                                eprintln!("Failed to pre-warm editor window: {}", e);
                            }
                        }
                    });
                });
            }

            // Start signed-out with a visible window; the webview calls
            // `update_tray_menu` once auth resolves and on every later change,
            // and visibility changes rebuild the menu too.
            let menu = build_tray_menu(app.handle(), false, true)?;

            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            let _tray = tauri::tray::TrayIconBuilder::with_id("main")
                .menu(&menu)
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("SyncShot")
                .on_menu_event(move |app, event| {
                    use std::sync::atomic::Ordering;
                    use tauri::Emitter;
                    use tauri::Manager;
                    match event.id().as_ref() {
                        "library" => {
                            let _ = app.emit("open-library", ());
                        }
                        "preferences" => {
                            let _ = app.emit("open-preferences", ());
                        }
                        "logout" => {
                            let _ = app.emit("tray-logout", ());
                        }
                        "quit" => {
                            // "Quit" hides the main window but leaves the app
                            // resident in the menu bar (tray). The tray icon is
                            // a permanent resident; it must survive Quit. Mirror
                            // the CloseRequested handler (hide, don't terminate).
                            // Reopen via the tray "Open App" item (shown once
                            // hidden) or any tray item that re-`show()`s the window.
                            if let Some(window) = app.get_webview_window("main") {
                                if let Err(e) = window.hide() {
                                    eprintln!("Failed to hide window on quit: {}", e);
                                }
                            }
                            app.state::<TrayState>()
                                .window_visible
                                .store(false, Ordering::Relaxed);
                            refresh_tray_menu(app);
                        }
                        "open" => {
                            // Shown when the window is hidden: bring it back and
                            // focus it. Focused(true) will flip the menu, but set
                            // it here too so state is correct even if focus is
                            // already elsewhere.
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                            app.state::<TrayState>()
                                .window_visible
                                .store(true, Ordering::Relaxed);
                            refresh_tray_menu(app);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capture_once,
            capture_all_monitors,
            capture_region,
            save_edited_image,
            save_edited_image_bytes,
            save_native_screenshot,
            copy_to_clipboard,
            delete_file,
            open_editor_window,
            take_editor_pending_path,
            get_desktop_directory,
            get_desktop_root,
            list_screenshots,
            get_temp_directory,
            get_screenshot_thumbnail,
            get_screenshot_thumbnail_path,
            read_image_bytes,
            file_exists,
            stat_file,
            native_capture_interactive,
            native_capture_fullscreen,
            native_capture_window,
            play_screenshot_sound,
            rename_screenshot_to_doc_id,
            download_synced_image,
            set_clipboard_text,
            get_mouse_position,
            cursor_display_bounds,
            get_machine_id,
            keychain_get,
            keychain_set,
            keychain_delete,
            browser_auth_listen,
            close_auth_window,
            update_tray_menu,
            set_pill_all_spaces
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // macOS Dock-icon click on an already-running app fires Reopen (no
            // new process, so the single-instance hook above never runs). If no
            // window is visible, resurface the column; otherwise just focus.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = event
            {
                use tauri::{Emitter, Manager};
                if has_visible_windows {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.set_focus();
                    }
                } else {
                    let _ = app_handle.emit("surface-column", ());
                }
            }
        });
}
