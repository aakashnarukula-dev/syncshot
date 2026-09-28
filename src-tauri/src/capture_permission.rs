//! The CoreGraphics request is process-scoped on macOS. Repeating it in a
//! long-lived process after removing its TCC entry may silently return false.
//! Execute the same signed app binary in a minimal request-only mode instead.
//! The responsible parent remains SyncShot; this never grants or resets access.

const REQUEST_ARG: &str = "--syncshot-request-screen-recording";
const DENIED: i32 = 10;

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
