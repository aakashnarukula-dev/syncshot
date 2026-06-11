//! ScreenshotX - A screenshot capture and editing application
//!
//! This crate provides the Tauri backend for capturing, editing,
//! and saving screenshots with various features like region selection
//! and background customization.

mod clipboard;
mod commands;
mod image;
mod license;
mod screenshot;
mod utils;

use commands::{
    capture_all_monitors, capture_once, capture_region, copy_to_clipboard, delete_file,
    get_desktop_directory, get_desktop_root, get_mouse_position, get_temp_directory,
    list_screenshots, native_capture_fullscreen, native_capture_interactive,
    native_capture_window, open_editor_window, play_screenshot_sound, save_edited_image,
    save_native_screenshot, save_synced_image, set_clipboard_text,
};
use license::{get_machine_id, keychain_delete, keychain_get, keychain_set};

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
        .setup(|app| {
            use tauri::Manager;
            use tauri_plugin_autostart::ManagerExt;

            // Regular (not Accessory) so the app shows a Dock icon with the
            // running indicator dot; clicking it re-surfaces the column.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);

            // Launch at login automatically (idempotent if already enabled).
            if let Err(e) = app.autolaunch().enable() {
                eprintln!("Failed to enable autostart: {}", e);
            }

            // Start the clipboard watcher: polls NSPasteboard.changeCount and
            // emits `clipboard-changed` so the webview can sync copies.
            crate::clipboard::start_clipboard_watcher(app.handle().clone());

            if let Some(window) = app.get_webview_window("main") {
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if let Err(e) = window_clone.hide() {
                            eprintln!("Failed to hide window: {}", e);
                        }
                        api.prevent_close();
                    }
                });
            }

            use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};

            let library_item =
                MenuItemBuilder::with_id("library", "Pair").build(app)?;

            let preferences_item =
                MenuItemBuilder::with_id("preferences", "Preferences…").build(app)?;

            let quit_item = MenuItemBuilder::with_id("quit", "Quit")
                .accelerator("CommandOrControl+Q")
                .build(app)?;

            let menu = MenuBuilder::new(app)
                .items(&[
                    &library_item,
                    &preferences_item,
                    &PredefinedMenuItem::separator(app)?,
                    &quit_item,
                ])
                .build()?;

            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            let _tray = tauri::tray::TrayIconBuilder::new()
                .menu(&menu)
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("ScreenshotX")
                .on_menu_event(move |app, event| {
                    use tauri::Emitter;
                    match event.id().as_ref() {
                        "library" => {
                            let _ = app.emit("open-library", ());
                        }
                        "preferences" => {
                            let _ = app.emit("open-preferences", ());
                        }
                        "quit" => {
                            app.exit(0);
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
            save_native_screenshot,
            copy_to_clipboard,
            delete_file,
            open_editor_window,
            get_desktop_directory,
            get_desktop_root,
            list_screenshots,
            get_temp_directory,
            native_capture_interactive,
            native_capture_fullscreen,
            native_capture_window,
            play_screenshot_sound,
            save_synced_image,
            set_clipboard_text,
            get_mouse_position,
            get_machine_id,
            keychain_get,
            keychain_set,
            keychain_delete
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
