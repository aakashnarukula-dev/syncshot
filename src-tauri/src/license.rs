use std::process::Command;

const KEYCHAIN_SERVICE: &str = "com.aakashnarukula.syncshot";

#[tauri::command]
pub fn get_machine_id() -> Result<String, String> {
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
pub fn keychain_set(key: String, value: String) -> Result<(), String> {
    let _ = Command::new("security")
        .args([
            "delete-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            &key,
        ])
        .output();
    let status = Command::new("security")
        .args([
            "add-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            &key,
            "-w",
            &value,
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
pub fn keychain_get(key: String) -> Result<Option<String>, String> {
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            &key,
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
pub fn keychain_delete(key: String) -> Result<(), String> {
    let _ = Command::new("security")
        .args([
            "delete-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            &key,
        ])
        .output();
    Ok(())
}
