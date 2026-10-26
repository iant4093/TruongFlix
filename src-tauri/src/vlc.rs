use serde::Serialize;
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const PREFERRED_PORT: u16 = 54321;
const POLL_INTERVAL: Duration = Duration::from_secs(3);

#[derive(Default)]
pub struct VlcState {
    current: Mutex<Option<Arc<Mutex<Child>>>>,
    /// Port and Basic-auth token of the running VLC's HTTP interface.
    http: Mutex<Option<(u16, String)>>,
}

#[derive(Clone, Serialize)]
struct ProgressPayload {
    media_type: String,
    media_id: i64,
    time: f64,
    length: f64,
}

#[derive(Clone, Serialize)]
struct ExitedPayload {
    media_type: String,
    media_id: i64,
    final_time: f64,
    length: f64,
}

// ---------------------------------------------------------------------------
// Detection & installation
// ---------------------------------------------------------------------------

fn candidate_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    #[cfg(target_os = "macos")]
    {
        paths.push(PathBuf::from("/Applications/VLC.app/Contents/MacOS/VLC"));
        if let Some(home) = std::env::var_os("HOME") {
            paths.push(Path::new(&home).join("Applications/VLC.app/Contents/MacOS/VLC"));
        }
    }
    #[cfg(target_os = "windows")]
    {
        paths.push(PathBuf::from(r"C:\Program Files\VideoLAN\VLC\vlc.exe"));
        paths.push(PathBuf::from(r"C:\Program Files (x86)\VideoLAN\VLC\vlc.exe"));
        for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Some(base) = std::env::var_os(var) {
                paths.push(Path::new(&base).join(r"VideoLAN\VLC\vlc.exe"));
                paths.push(Path::new(&base).join(r"Programs\VideoLAN\VLC\vlc.exe"));
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        paths.push(PathBuf::from("/usr/bin/vlc"));
        paths.push(PathBuf::from("/usr/local/bin/vlc"));
        paths.push(PathBuf::from("/snap/bin/vlc"));
    }
    paths
}

#[tauri::command]
pub fn detect_vlc() -> Option<String> {
    candidate_paths()
        .into_iter()
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Installs VLC through the OS package manager (winget / Homebrew), then re-detects it.
#[tauri::command]
pub async fn install_vlc() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let output = install_command()?
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("Failed to start installer: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let msg = if stderr.trim().is_empty() { stdout } else { stderr };
            return Err(format!("Installer failed: {}", msg.trim()));
        }
        Ok(detect_vlc())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(target_os = "macos")]
fn install_command() -> Result<Command, String> {
    // GUI apps do not inherit the shell PATH, so look for Homebrew explicitly.
    let brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
        .into_iter()
        .find(|p| Path::new(p).is_file())
        .ok_or("Homebrew was not found. Install VLC from https://www.videolan.org/vlc/ instead.")?;
    let mut cmd = Command::new(brew);
    cmd.args(["install", "--cask", "vlc"]);
    Ok(cmd)
}

#[cfg(target_os = "windows")]
fn install_command() -> Result<Command, String> {
    let mut cmd = Command::new("winget");
    cmd.args([
        "install",
        "-e",
        "--id",
        "VideoLAN.VLC",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
    ]);
    Ok(cmd)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn install_command() -> Result<Command, String> {
    Err("Automatic installation is not supported on this platform.".into())
}

// ---------------------------------------------------------------------------
// Launch & progress polling
// ---------------------------------------------------------------------------

fn pick_port() -> u16 {
    if TcpListener::bind(("127.0.0.1", PREFERRED_PORT)).is_ok() {
        return PREFERRED_PORT;
    }
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(PREFERRED_PORT)
}

fn random_password() -> String {
    let mut out = String::new();
    for i in 0..2u64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(i);
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default(),
        );
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

fn base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Minimal HTTP/1.0 client for VLC's Lua status endpoint (avoids pulling in an HTTP crate).
async fn fetch_status(port: u16, auth: &str) -> Option<(f64, f64)> {
    status_request(port, auth, "").await
}

/// `query` is e.g. "?command=pl_forcepause".
async fn status_request(port: u16, auth: &str, query: &str) -> Option<(f64, f64)> {
    let request = async {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.ok()?;
        let req = format!(
            "GET /requests/status.json{query} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Basic {auth}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(req.as_bytes()).await.ok()?;
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).await.ok()?;
        Some(buf)
    };
    let buf = tokio::time::timeout(Duration::from_secs(2), request).await.ok()??;
    let text = String::from_utf8_lossy(&buf);
    let (head, body) = text.split_once("\r\n\r\n")?;
    if !head.lines().next().unwrap_or_default().contains(" 200") {
        return None;
    }
    // Tolerate chunked framing by isolating the JSON object.
    let json = &body[body.find('{')?..=body.rfind('}')?];
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let time = value.get("time").and_then(|v| v.as_f64())?;
    let length = value.get("length").and_then(|v| v.as_f64()).unwrap_or(0.0);
    Some((time, length))
}

fn restore_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn launch_vlc(
    app: AppHandle,
    state: State<'_, VlcState>,
    file_path: String,
    start_time: u64,
    media_type: String,
    media_id: i64,
    vlc_path: Option<String>,
    subtitle_path: Option<String>,
) -> Result<(), String> {
    let vlc = vlc_path
        .filter(|p| Path::new(p).is_file())
        .or_else(detect_vlc)
        .ok_or("VLC was not found. Install VLC or set its path in Settings.")?;
    if !Path::new(&file_path).is_file() {
        return Err(format!("File not found: {file_path}"));
    }

    // Only one playback session at a time.
    if let Some(prev) = state.current.lock().map_err(|e| e.to_string())?.take() {
        if let Ok(mut child) = prev.lock() {
            let _ = child.kill();
        }
    }

    let port = pick_port();
    let password = random_password();
    let mut cmd = Command::new(&vlc);
    cmd.arg(&file_path);
    // Selected external subtitle (downloaded or sidecar); silently skipped if it was deleted.
    if let Some(sub) = subtitle_path.filter(|p| Path::new(p).is_file()) {
        cmd.arg(format!("--sub-file={sub}"));
    }
    let child = cmd
        .arg("--fullscreen")
        .arg("--play-and-exit")
        .arg(format!("--start-time={start_time}"))
        .arg("--extraintf=http")
        .arg("--http-host=127.0.0.1")
        .arg(format!("--http-port={port}"))
        .arg(format!("--http-password={password}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to launch VLC: {e}"))?;

    let child = Arc::new(Mutex::new(child));
    *state.current.lock().map_err(|e| e.to_string())? = Some(child.clone());

    let auth = base64(format!(":{password}").as_bytes());
    *state.http.lock().map_err(|e| e.to_string())? = Some((port, auth.clone()));
    tauri::async_runtime::spawn(async move {
        let mut last_time = start_time as f64;
        let mut last_length = 0.0_f64;
        tokio::time::sleep(Duration::from_millis(1500)).await;
        loop {
            let alive = child
                .lock()
                .map(|mut c| matches!(c.try_wait(), Ok(None)))
                .unwrap_or(false);
            if !alive {
                break;
            }
            if let Some((time, length)) = fetch_status(port, &auth).await {
                if length > 0.0 {
                    last_time = time;
                    last_length = length;
                    let _ = app.emit(
                        "vlc-progress",
                        ProgressPayload {
                            media_type: media_type.clone(),
                            media_id,
                            time,
                            length,
                        },
                    );
                }
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }

        let _ = app.emit(
            "vlc-exited",
            ExitedPayload {
                media_type,
                media_id,
                final_time: last_time,
                length: last_length,
            },
        );
        restore_main_window(&app);
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648() {
        assert_eq!(base64(b":"), "Og==");
        assert_eq!(base64(b":pw"), "OnB3");
        assert_eq!(base64(b":testpw"), "OnRlc3Rwdw==");
    }

    /// Requires a local VLC install: `TRUONGFLIX_TEST_VIDEO=/path/to/video cargo test -- --ignored`
    #[test]
    #[ignore]
    fn polls_real_vlc_status() {
        let video = std::env::var("TRUONGFLIX_TEST_VIDEO").expect("set TRUONGFLIX_TEST_VIDEO");
        let vlc = detect_vlc().expect("VLC not installed");
        let port = pick_port();
        let password = random_password();
        let mut child = Command::new(vlc)
            .args([&video, "-I", "dummy", "--play-and-exit", "--no-audio", "--start-time=1"])
            .arg("--extraintf=http")
            .arg("--http-host=127.0.0.1")
            .arg(format!("--http-port={port}"))
            .arg(format!("--http-password={password}"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let auth = base64(format!(":{password}").as_bytes());
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let mut seen = None;
        for _ in 0..10 {
            std::thread::sleep(Duration::from_millis(700));
            if let Some((t, l)) = rt.block_on(fetch_status(port, &auth)) {
                if l > 0.0 {
                    seen = Some((t, l));
                    break;
                }
            }
        }
        let _ = child.kill();
        let (time, length) = seen.expect("never received a status with a length");
        println!("VLC status: time={time} length={length}");
        assert!(length > 0.0 && time >= 0.0);
    }
}

/// Pauses VLC (used when the screen locks). No-op when VLC isn't running.
#[tauri::command]
pub async fn pause_vlc(state: State<'_, VlcState>) -> Result<(), String> {
    let http = state.http.lock().map_err(|e| e.to_string())?.clone();
    if let Some((port, auth)) = http {
        let _ = status_request(port, &auth, "?command=pl_forcepause").await;
    }
    Ok(())
}

#[tauri::command]
pub fn stop_vlc(state: State<'_, VlcState>) -> Result<(), String> {
    if let Some(child) = state.current.lock().map_err(|e| e.to_string())?.take() {
        if let Ok(mut c) = child.lock() {
            let _ = c.kill();
        }
    }
    Ok(())
}
