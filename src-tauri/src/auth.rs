//! Google OAuth runs in the system browser. A one-shot loopback callback
//! validates a cryptographically random state before accepting a custom token.
//! Linking tokens travel in the URL fragment, never in hosting request logs.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

/// Hosted sign-in page (Firebase Hosting; an auto-authorized Firebase Auth
/// domain, so reCAPTCHA/phone work there with no extra config).
const AUTH_PAGE_URL: &str = "https://syncshot-v2.web.app/auth.html";

/// Label of the embedded sign-in `WebviewWindow`. Not listed in any capability
/// (it only loads a remote page + navigates to the loopback callback — it never
/// calls a Tauri command), so it intentionally has no IPC access.
const AUTH_WINDOW_LABEL: &str = "auth";

/// How long to wait for the sign-in round-trip before giving up.
const AUTH_TIMEOUT: Duration = Duration::from_secs(300);

// Dark, minimal "code-like" pages for the SYSTEM-BROWSER fallback (the embedded
// path never renders these — it cancels the callback navigation). Best-effort
// self-close: Chrome blocks a bare `window.close()` on a tab it didn't
// script-open; the `window.open('','_self')` trick re-marks it as script-opened,
// which lets close() through in most setups. The text stays as the final
// fallback, and the Rust side raises the app window regardless (see `focus_app`).
const SUCCESS_HTML: &str = "<!doctype html><html><head><meta charset=utf-8>\
<title>Signed in</title><style>:root{color-scheme:dark}html,body{height:100%}\
body{margin:0;background:#0b0b0e;color:#e7e7ea;\
font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;display:grid;place-items:center}\
.card{text-align:center;padding:2rem}.ok{color:#3ecf8e}\
.muted{color:#8a8a93;margin-top:.5rem;font-size:13px}</style></head>\
<body><div class=card><div><span class=ok>●</span> Signed in</div>\
<div class=muted>You can close this tab and return to SyncShot.</div></div>\
<script>try{window.open('','_self');window.close();}catch(e){}\
setTimeout(function(){try{window.open('','_self');window.close();}catch(e){}},50);</script>\
</body></html>";

const ERROR_HTML: &str = "<!doctype html><html><head><meta charset=utf-8>\
<title>Sign-in failed</title><style>:root{color-scheme:dark}html,body{height:100%}\
body{margin:0;background:#0b0b0e;color:#e7e7ea;\
font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;display:grid;place-items:center}\
.card{text-align:center;padding:2rem}.warn{color:#f0a35e}\
.muted{color:#8a8a93;margin-top:.5rem;font-size:13px}</style></head>\
<body><div class=card><div><span class=warn>●</span> Sign-in couldn't be verified</div>\
<div class=muted>Return to SyncShot and try again.</div></div></body></html>";

/// Validate the `state` nonce and lift the Firebase custom token out of a
/// callback query string (`token=…&state=…`). Pure — unit-tested.
fn parse_query(query: &str, expected_state: &str) -> Result<String, String> {
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
            "token" if token.is_none() => token = Some(decoded),
            "state" if state.is_none() => state = Some(decoded),
            "token" | "state" => return Err("duplicate callback parameter".into()),
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

/// Extract the custom token from a callback HTTP request line, after verifying
/// the `state` nonce. `request_line` is e.g. `GET /?token=abc&state=xyz HTTP/1.1`.
fn parse_callback(request_line: &str, expected_state: &str) -> Result<String, String> {
    if !request_line.starts_with("GET /?") {
        return Err("invalid callback method or path".into());
    }
    let target = request_line
        .split_whitespace()
        .nth(1)
        .ok_or("malformed request")?;
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    parse_query(query, expected_state)
}

/// 128-bit hex nonce from the OS CSPRNG. Ties the sign-in session to THIS
/// invocation so another local process can't inject a token of its own.
fn gen_nonce() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    let mut f = std::fs::File::open("/dev/urandom").map_err(|e| e.to_string())?;
    f.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn respond(stream: &mut TcpStream, body: &str) {
    let res = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
         Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(res.as_bytes());
    let _ = stream.flush();
}

/// Block (until `AUTH_TIMEOUT`) on the loopback listener for the one request
/// bearing a valid `token`+`state`. Stray hits (favicon, etc.) are answered and
/// ignored. Used by the SYSTEM-BROWSER fallback.
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
                    match parse_callback(line, expected_state) {
                        Ok(token) => {
                            respond(&mut stream, SUCCESS_HTML);
                            return Ok(token);
                        }
                        Err(_) => {
                            respond(&mut stream, ERROR_HTML);
                            continue; // An invalid callback must not cancel the legitimate attempt.
                        }
                    }
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

/// Raise the SyncShot app (and its main window) back to the foreground after
/// a successful sign-in.
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

fn close_auth_window_impl(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window(AUTH_WINDOW_LABEL) {
        let _ = w.close();
    }
}

/// Frontend escape hatch: dismiss the embedded sign-in window before falling
/// back to the system browser.
#[tauri::command]
pub fn close_auth_window(app: tauri::AppHandle) {
    close_auth_window_impl(&app);
}

/// Open the hosted sign-in page in the user's default browser and wait for the
/// callback token over loopback.
async fn browser_auth(app: tauri::AppHandle, link_token: Option<String>) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;

    let state = gen_nonce()?;
    let mut url = format!("{AUTH_PAGE_URL}?cb_port={port}&state={state}");
    if let Some(token) = link_token {
        url.push_str(&format!("#link_token={}", urlencoding::encode(&token)));
    }

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("failed to open browser: {e}"))?;

    let _ = &app; // referenced below only on success

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

/// Start a sign-in round-trip and resolve with the minted Firebase custom token.
///
/// `embed` (default `true`) runs the flow in an app-owned webview window that the
/// app closes itself on completion. `embed = false` shells the page out to the
/// system browser (fallback for when the embedded webview can't run reCAPTCHA).
#[tauri::command]
pub async fn browser_auth_listen(
    app: tauri::AppHandle,
    embed: Option<bool>,
    link_token: Option<String>,
) -> Result<String, String> {
    let _ = embed; // Old clients may pass this; Google must use a system browser.
    let result = browser_auth(app.clone(), link_token).await;
    if result.is_ok() {
        focus_app(&app);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{parse_callback, parse_query};

    #[test]
    fn rejects_ambiguous_or_non_get_callbacks() {
        for line in [
            "GET /?token=a&token=b&state=n HTTP/1.1",
            "GET /?token=a&state=n&state=n HTTP/1.1",
            "POST /?token=a&state=n HTTP/1.1",
            "GET /other?token=a&state=n HTTP/1.1",
        ] {
            assert!(parse_callback(line, "n").is_err(), "{line}");
        }
    }

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

    // `on_navigation` parses the callback query directly off the intercepted URL.
    #[test]
    fn parse_query_lifts_token_from_callback_url() {
        assert_eq!(parse_query("token=tok&state=n", "n").unwrap(), "tok");
        assert!(parse_query("token=tok&state=bad", "n").is_err());
    }
}
