//! System-browser sign-in callback listener.
//!
//! Firebase phone-auth's reCAPTCHA rejects the Tauri webview origin
//! (`tauri://localhost`) with `auth/invalid-app-credential`. So we run phone +
//! reCAPTCHA + OTP on a real https domain in the user's default browser, mint a
//! Firebase custom token there, and hand it back to the app over a one-shot
//! loopback HTTP listener (the RFC 8252 native-app pattern).

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

/// Hosted sign-in page (Firebase Hosting; an auto-authorized Firebase Auth
/// domain, so reCAPTCHA/phone work there with no extra config).
const AUTH_PAGE_URL: &str = "https://screenshot-x-v1.web.app/auth.html";

/// How long to wait for the browser round-trip before giving up.
const AUTH_TIMEOUT: Duration = Duration::from_secs(300);

// Best-effort self-close on success. Chrome blocks a bare `window.close()` on a
// tab it didn't script-open ("Scripts may close only the windows that were
// opened by them") — and our tab is opened via the system `open` + a top-level
// redirect, so plain close() is refused. The `window.open('','_self')` trick
// re-marks the current tab as script-opened, which lets close() through in most
// Chrome setups; we also retry after a tick. The friendly text stays as the
// final fallback for any browser that still refuses, and the Rust side raises
// the app window regardless (see `focus_app`).
const SUCCESS_HTML: &str = "<!doctype html><meta charset=utf-8><title>Signed in</title>\
<body style=\"font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0\">\
<p>✅ Signed in. You can close this tab and return to ScreenshotX.</p>\
<script>\
try { window.open('', '_self'); window.close(); } catch (e) {}\
setTimeout(function(){ try { window.open('','_self'); window.close(); } catch(e){} }, 50);\
</script>";

const ERROR_HTML: &str = "<!doctype html><meta charset=utf-8><title>Sign-in failed</title>\
<body style=\"font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0\">\
<p>⚠️ Sign-in could not be verified. Please return to ScreenshotX and try again.</p>";

/// Extract the Firebase custom token from a callback HTTP request line, after
/// verifying the `state` nonce matches the one we generated. Pure — unit-tested.
///
/// `request_line` is the first line of the request, e.g.
/// `GET /?token=abc&state=xyz HTTP/1.1`.
fn parse_callback(request_line: &str, expected_state: &str) -> Result<String, String> {
    let target = request_line
        .split_whitespace()
        .nth(1)
        .ok_or("malformed request")?;
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");

    let mut token: Option<String> = None;
    let mut state: Option<String> = None;
    for pair in query.split('&') {
        let Some((k, v)) = pair.split_once('=') else {
            continue;
        };
        let decoded = urlencoding::decode(v)
            .map_err(|e| e.to_string())?
            .into_owned();
        match k {
            "token" => token = Some(decoded),
            "state" => state = Some(decoded),
            _ => {}
        }
    }

    match state.as_deref() {
        Some(s) if s == expected_state => {}
        Some(_) => return Err("state mismatch".into()),
        None => return Err("missing state".into()),
    }
    token
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "missing token".into())
}

/// 128-bit hex nonce from the OS CSPRNG. Ties the browser session to THIS
/// listener so another local process can't inject a token of its own.
fn gen_nonce() -> String {
    let mut bytes = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut bytes);
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn respond(stream: &mut TcpStream, body: &str) {
    let res = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(res.as_bytes());
    let _ = stream.flush();
}

/// Block (until `AUTH_TIMEOUT`) on the loopback listener for the one request
/// bearing a valid `token`+`state`. Stray hits (favicon, etc.) are answered and
/// ignored.
fn accept_token(listener: &TcpListener, expected_state: &str) -> Result<String, String> {
    let deadline = Instant::now() + AUTH_TIMEOUT;
    loop {
        if Instant::now() >= deadline {
            return Err("Sign-in timed out. Please try again.".into());
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let line = req.lines().next().unwrap_or("");
                if line.contains("token=") {
                    return match parse_callback(line, expected_state) {
                        Ok(token) => {
                            respond(&mut stream, SUCCESS_HTML);
                            Ok(token)
                        }
                        Err(e) => {
                            respond(&mut stream, ERROR_HTML);
                            Err(e)
                        }
                    };
                }
                // Favicon / stray hit — acknowledge and keep waiting.
                respond(&mut stream, SUCCESS_HTML);
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Raise the ScreenshotX app (and its main window) back to the foreground after
/// a successful sign-in. The callback tab may not auto-close (a known Chrome
/// limitation for tabs it didn't script-open), so this guarantees the user lands
/// back in the app regardless of what the browser does with the tab.
fn focus_app(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }

    // `set_focus` alone doesn't reliably pull a *background* app to the front on
    // macOS; explicitly activate the NSApplication. Same objc2 msg_send idiom as
    // the rest of the macOS native paths (clipboard.rs, lib.rs).
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        if let Some(cls) = objc2::runtime::AnyClass::get("NSApplication") {
            let ns_app: *mut AnyObject = msg_send![cls, sharedApplication];
            if !ns_app.is_null() {
                let _: () = msg_send![ns_app, activateIgnoringOtherApps: true];
            }
        }
    }
}

/// Open the hosted sign-in page in the user's default browser, then wait for the
/// page to redirect back the minted Firebase custom token over loopback.
#[tauri::command]
pub async fn browser_auth_listen(app: tauri::AppHandle) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;

    let state = gen_nonce();
    let url = format!("{AUTH_PAGE_URL}?cb_port={port}&state={state}");

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("failed to open browser: {e}"))?;

    let result = tauri::async_runtime::spawn_blocking(move || accept_token(&listener, &state))
        .await
        .map_err(|e| e.to_string())?;

    // On a verified token, return the user to the app even if the browser keeps
    // the "Signed in" tab open.
    if result.is_ok() {
        focus_app(&app);
    }

    result
}

#[cfg(test)]
mod tests {
    use super::parse_callback;

    #[test]
    fn parses_token_with_matching_state() {
        let line = "GET /?token=abc123&state=nonce HTTP/1.1";
        assert_eq!(parse_callback(line, "nonce").unwrap(), "abc123");
    }

    #[test]
    fn order_independent() {
        let line = "GET /?state=n&token=tok HTTP/1.1";
        assert_eq!(parse_callback(line, "n").unwrap(), "tok");
    }

    #[test]
    fn url_decodes_token() {
        let line = "GET /?token=a%2Bb%2Fc&state=n HTTP/1.1";
        assert_eq!(parse_callback(line, "n").unwrap(), "a+b/c");
    }

    #[test]
    fn rejects_state_mismatch() {
        let line = "GET /?token=abc&state=evil HTTP/1.1";
        assert!(parse_callback(line, "nonce").is_err());
    }

    #[test]
    fn rejects_missing_state() {
        let line = "GET /?token=abc HTTP/1.1";
        assert!(parse_callback(line, "nonce").is_err());
    }

    #[test]
    fn rejects_missing_token() {
        let line = "GET /?state=nonce HTTP/1.1";
        assert!(parse_callback(line, "nonce").is_err());
    }

    #[test]
    fn rejects_empty_token() {
        let line = "GET /?token=&state=nonce HTTP/1.1";
        assert!(parse_callback(line, "nonce").is_err());
    }
}
