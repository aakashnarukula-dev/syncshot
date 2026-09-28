//! The CoreGraphics request is process-scoped on macOS. Repeating it in a
//! long-lived process after removing its TCC entry may silently return false.
//! Execute the same signed app binary in a minimal request-only mode instead.
//! The responsible parent remains SyncShot; this never grants or resets access.

const REQUEST_ARG: &str = "--syncshot-request-screen-recording";
const DENIED: i32 = 10;

/// Tracks an unanswered request, never a cached permission grant. macOS owns
/// the first consent dialog; later blocked attempts need a visible Settings
/// destination because macOS may suppress repeated consent dialogs.
#[derive(Default)]
struct RecoveryState {
    awaiting_grant: bool,
}

impl RecoveryState {
    fn observe(&mut self, granted: bool) -> bool {
        let open_settings = !granted && self.awaiting_grant;
        self.awaiting_grant = !granted;
        open_settings
    }
}

pub(crate) fn recover_if_needed(granted: bool) -> Result<(), String> {
    static STATE: std::sync::Mutex<RecoveryState> = std::sync::Mutex::new(RecoveryState {
        awaiting_grant: false,
    });
    let open_settings = STATE
        .lock()
        .map_err(|_| "Screen Recording permission state unavailable".to_string())?
        .observe(granted);
    if open_settings {
        #[cfg(target_os = "macos")]
        {
            let status = std::process::Command::new("/usr/bin/open")
                .arg(
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
                )
                .status()
                .map_err(|e| format!("Could not open Screen Recording permission settings: {e}"))?;
            if !status.success() {
                return Err("Could not open Screen Recording permission settings".into());
            }
            crate::commands::capture_diagnostic("permission-settings-opened");
        }
    }
    Ok(())
}

fn is_request_mode(args: &[std::ffi::OsString]) -> bool {
    args.len() == 2 && args[1] == REQUEST_ARG
}

/// Called before Tauri, the single-instance plugin, webviews, or cloud sync.
pub fn run_if_requested() -> Option<i32> {
    if !is_request_mode(&std::env::args_os().collect::<Vec<_>>()) {
        return None;
    }
    #[cfg(target_os = "macos")]
    {
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGPreflightScreenCaptureAccess() -> bool;
            fn CGRequestScreenCaptureAccess() -> bool;
        }
        let granted = unsafe { CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() };
        Some(if granted { 0 } else { DENIED })
    }
    #[cfg(not(target_os = "macos"))]
    Some(0)
}

fn permission_result(code: Option<i32>) -> Result<bool, String> {
    match code {
        Some(0) => Ok(true),
        Some(DENIED) => Ok(false),
        _ => Err("Screen Recording permission helper failed".into()),
    }
}

pub fn request() -> Result<bool, String> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let executable = std::env::current_exe()
        .map_err(|e| format!("Could not locate SyncShot for permission request: {e}"))?;
    let mut child = Command::new(executable)
        .arg(REQUEST_ARG)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not request Screen Recording permission: {e}"))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return permission_result(status.code()),
            Ok(None) if started.elapsed() < Duration::from_secs(120) => {
                std::thread::sleep(Duration::from_millis(25));
            }
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(match result {
                    Err(e) => format!("Screen Recording permission helper failed: {e}"),
                    _ => "Screen Recording permission request timed out".into(),
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn first_denial_keeps_native_prompt_then_retries_open_settings() {
        let mut state = RecoveryState::default();
        assert!(!state.observe(false)); // System prompt adds the app to Settings.
        assert!(state.observe(false)); // User closed Settings without enabling it.
        assert!(state.observe(false)); // Closing Settings again must not strand them.
    }

    #[test]
    fn granting_access_stops_settings_and_resets_next_revocation() {
        let mut state = RecoveryState::default();
        assert!(!state.observe(false));
        assert!(state.observe(false));
        assert!(!state.observe(true));
        assert!(!state.observe(true));
        assert!(!state.observe(false)); // A newly revoked grant gets a native request.
        assert!(state.observe(false));
    }

    #[test]
    fn authorized_captures_never_open_settings() {
        let mut state = RecoveryState::default();
        for _ in 0..3 {
            assert!(!state.observe(true));
        }
    }
    #[test]
    fn helper_mode_requires_exact_internal_argument() {
        let args = |values: &[&str]| values.iter().map(OsString::from).collect::<Vec<_>>();
        assert!(is_request_mode(&args(&["SyncShot", REQUEST_ARG])));
        assert!(!is_request_mode(&args(&["SyncShot"])));
        assert!(!is_request_mode(&args(&["SyncShot", "--other"])));
        assert!(!is_request_mode(&args(&["SyncShot", REQUEST_ARG, "extra"])));
    }
    #[test]
    fn crashes_and_unknown_exit_codes_cannot_grant_access() {
        assert_eq!(permission_result(Some(0)), Ok(true));
        assert_eq!(permission_result(Some(DENIED)), Ok(false));
        assert!(permission_result(None).is_err());
        assert!(permission_result(Some(1)).is_err());
    }
}
