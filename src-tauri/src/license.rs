use std::process::Command;

const KEYCHAIN_SERVICE: &str = "com.aakashnarukula.syncshot";

// Every command here shells out to a system tool (`ioreg`, `security`) with a
// blocking wait of 50–500ms. They are async + spawn_blocking because a SYNC
// Tauri command body runs on the MAIN thread — where each of these waits
// stalled all IPC and rendering (keychain_get fires at startup and every 60s
// from the frontend).

fn get_machine_id_blocking() -> Result<String, String> {
    let output = Command::new("ioreg")
        .args(["-d2", "-c", "IOPlatformExpertDevice"])
        .output()
        .map_err(|e| format!("ioreg failed: {}", e))?;
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if line.contains("IOPlatformUUID") {
            if let Some(uuid) = line.split('"').nth(3) {
                return Ok(uuid.to_string());
            }
        }
    }
    Err("IOPlatformUUID not found".into())
}

#[tauri::command]
pub async fn get_machine_id() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(get_machine_id_blocking)
        .await
        .map_err(|e| format!("machine-id task failed: {}", e))?
}

fn keychain_set_blocking(key: &str, value: &str) -> Result<(), String> {
    let _ = Command::new("security")
        .args(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", key])
        .output();
    let status = Command::new("security")
        .args([
            "add-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            key,
            "-w",
            value,
            "-U",
        ])
        .status()
        .map_err(|e| format!("security add failed: {}", e))?;
    if !status.success() {
        return Err(format!("security add exited with {:?}", status.code()));
    }
    Ok(())
}

#[tauri::command]
pub async fn keychain_set(key: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || keychain_set_blocking(&key, &value))
        .await
        .map_err(|e| format!("keychain task failed: {}", e))?
}

fn keychain_get_blocking(key: &str) -> Result<Option<String>, String> {
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            key,
            "-w",
        ])
        .output()
        .map_err(|e| format!("security find failed: {}", e))?;
    if !output.status.success() {
        return Ok(None);
    }
    let val = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if val.is_empty() {
        Ok(None)
    } else {
        Ok(Some(val))
    }
}

#[tauri::command]
pub async fn keychain_get(key: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || keychain_get_blocking(&key))
        .await
        .map_err(|e| format!("keychain task failed: {}", e))?
}

fn keychain_delete_blocking(key: &str) -> Result<(), String> {
    let _ = Command::new("security")
        .args(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", key])
        .output();
    Ok(())
}

#[tauri::command]
pub async fn keychain_delete(key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || keychain_delete_blocking(&key))
        .await
        .map_err(|e| format!("keychain task failed: {}", e))?
}
