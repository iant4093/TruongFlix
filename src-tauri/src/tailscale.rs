//! Helps reach the browser app away from home through Tailscale. Only Tailscale Serve is used
//! (reachable by devices signed in to the same Tailscale account); Funnel, which publishes to the
//! internet, is never turned on.

use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn candidates() -> Vec<PathBuf> {
    let mut list = Vec::new();
    #[cfg(windows)]
    {
        for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Ok(dir) = std::env::var(var) {
                list.push(PathBuf::from(dir).join("Tailscale").join("tailscale.exe"));
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        list.push(PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale"));
        list.push(PathBuf::from("/opt/homebrew/bin/tailscale"));
        list.push(PathBuf::from("/usr/local/bin/tailscale"));
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    list.push(PathBuf::from("/usr/bin/tailscale"));
    list
}

fn cli() -> Option<PathBuf> {
    candidates().into_iter().find(|p| p.is_file())
}

fn command(exe: &PathBuf, args: &[&str]) -> Command {
    let mut cmd = Command::new(exe);
    cmd.args(args).stdin(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Runs the CLI with a time limit, returning stdout and stderr combined. A "visit this URL"
/// prompt (Tailscale asking the account owner to approve a feature) ends the wait early.
fn run(exe: &PathBuf, args: &[&str], timeout: Duration) -> Result<(bool, String), String> {
    let mut child = command(exe, args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't run Tailscale: {e}"))?;
    let (tx, rx) = mpsc::channel::<String>();
    for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>)].into_iter().flatten() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        });
    }
    drop(tx);
    let started = std::time::Instant::now();
    let mut output = String::new();
    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => {
                output.push_str(&line);
                output.push('\n');
                if approval_url(&output).is_some() {
                    let _ = child.kill();
                    return Ok((false, output));
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            return Err("Tailscale didn't respond in time.".into());
        }
    }
    let ok = child.wait().map(|s| s.success()).unwrap_or(false);
    Ok((ok, output))
}

/// The admin-console link Tailscale prints when Serve or HTTPS must be approved for the account.
fn approval_url(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .find(|w| w.starts_with("https://login.tailscale.com/"))
        .map(|w| w.trim_end_matches(['.', ',', ')']).to_string())
}

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleStatus {
    pub installed: bool,
    /// "Running", "NeedsLogin", "Stopped", "Starting", "NoState" or "" when unknown.
    pub state: String,
    pub ipv4: Option<String>,
    /// This device's name in the tailnet, e.g. `my-pc.tail1234.ts.net`.
    pub dns_name: Option<String>,
    /// HTTPS certificates are enabled for the tailnet.
    pub https_enabled: bool,
    /// Tailscale Serve forwards `https://<dns_name>` to TruongFlix's port.
    pub serving: bool,
    /// Serve on that address is something else (TruongFlix won't replace it).
    pub port_in_use: bool,
    /// That address is published to the internet with Funnel.
    pub funnel: bool,
}

fn parse_status(json: &Value) -> TailscaleStatus {
    let me = &json["Self"];
    TailscaleStatus {
        installed: true,
        state: json["BackendState"].as_str().unwrap_or_default().to_string(),
        ipv4: me["TailscaleIPs"].as_array().and_then(|ips| ips.iter().filter_map(Value::as_str).find(|ip| ip.contains('.')).map(str::to_string)),
        dns_name: me["DNSName"].as_str().map(|s| s.trim_end_matches('.').to_string()).filter(|s| !s.is_empty()),
        https_enabled: json["CertDomains"].as_array().is_some_and(|d| !d.is_empty()),
        ..Default::default()
    }
}

/// Reads `tailscale serve status --json` for `https://<dns_name>:443`.
fn apply_serve_status(status: &mut TailscaleStatus, json: &Value, port: u16) {
    let Some(name) = status.dns_name.clone() else { return };
    let host = format!("{name}:443");
    let handlers = &json["Web"][&host]["Handlers"];
    let ours = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    let proxies: Vec<&str> = handlers.as_object().map(|h| h.values().filter_map(|v| v["Proxy"].as_str()).collect()).unwrap_or_default();
    status.serving = proxies.iter().any(|p| ours.iter().any(|o| p.contains(o.as_str())));
    status.port_in_use = !status.serving && (json["TCP"]["443"].is_object() || handlers.is_object());
    status.funnel = json["AllowFunnel"][&host].as_bool().unwrap_or(false);
}

/// This device's tailnet name from the last status check; the media server only accepts browser
/// pages served from it via Tailscale Serve.
static OWN_DNS_NAME: Mutex<Option<String>> = Mutex::new(None);

pub fn own_dns_name() -> Option<String> {
    OWN_DNS_NAME.lock().unwrap().clone()
}

fn base_status(exe: &PathBuf) -> TailscaleStatus {
    let status = match run(exe, &["status", "--json"], Duration::from_secs(8)) {
        Ok((_, out)) => serde_json::from_str::<Value>(&out).map(|j| parse_status(&j)).unwrap_or(TailscaleStatus { installed: true, ..Default::default() }),
        Err(_) => TailscaleStatus { installed: true, ..Default::default() },
    };
    if status.dns_name.is_some() {
        *OWN_DNS_NAME.lock().unwrap() = status.dns_name.clone();
    }
    status
}

/// Learns this device's tailnet name in the background (when the media server starts).
pub fn refresh_dns_name() {
    std::thread::spawn(|| {
        if let Some(exe) = cli() {
            base_status(&exe);
        }
    });
}

fn status_blocking(port: u16) -> TailscaleStatus {
    let Some(exe) = cli() else { return TailscaleStatus::default() };
    let mut status = base_status(&exe);
    if status.state == "Running" {
        if let Ok((_, out)) = run(&exe, &["serve", "status", "--json"], Duration::from_secs(8)) {
            if let Ok(json) = serde_json::from_str::<Value>(&out) {
                apply_serve_status(&mut status, &json, port);
            }
        }
    }
    status
}

#[tauri::command]
pub async fn tailscale_status(port: u16) -> TailscaleStatus {
    tauri::async_runtime::spawn_blocking(move || status_blocking(port)).await.unwrap_or_default()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServeResult {
    status: TailscaleStatus,
    /// Set when the Tailscale account owner must approve HTTPS/Serve first.
    approval_url: Option<String>,
}

/// Turns the private `https://<device>.ts.net` address for TruongFlix on or off.
#[tauri::command]
pub async fn tailscale_serve(enable: bool, port: u16) -> Result<ServeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let exe = cli().ok_or("Tailscale isn't installed")?;
        let before = status_blocking(port);
        if before.state != "Running" {
            return Err("Open Tailscale and sign in first.".into());
        }
        if enable && before.port_in_use {
            return Err("Tailscale Serve already shares something else at this computer's address. Turn it off in Tailscale first.".into());
        }
        let target = format!("http://127.0.0.1:{port}");
        let args: Vec<&str> = if enable { vec!["serve", "--bg", "--https=443", &target] } else { vec!["serve", "--https=443", "off"] };
        if !enable && !before.serving {
            return Ok(ServeResult { status: before, approval_url: None });
        }
        let (ok, output) = run(&exe, &args, Duration::from_secs(30))?;
        if let Some(url) = approval_url(&output) {
            return Ok(ServeResult { status: status_blocking(port), approval_url: Some(url) });
        }
        let status = status_blocking(port);
        if !ok && status.serving != enable {
            let detail = output.lines().find(|l| !l.trim().is_empty()).unwrap_or("Tailscale reported an error").trim().to_string();
            return Err(detail);
        }
        Ok(ServeResult { status, approval_url: None })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_tailscale_status() {
        let json: Value = serde_json::from_str(
            r#"{"BackendState":"Running","CertDomains":["my-pc.tail1234.ts.net"],
                "Self":{"DNSName":"my-pc.tail1234.ts.net.","TailscaleIPs":["100.101.102.103","fd7a:115c:a1e0::1"]}}"#,
        )
        .unwrap();
        let s = parse_status(&json);
        assert_eq!(s.state, "Running");
        assert_eq!(s.ipv4.as_deref(), Some("100.101.102.103"));
        assert_eq!(s.dns_name.as_deref(), Some("my-pc.tail1234.ts.net"));
        assert!(s.https_enabled);
    }

    #[test]
    fn recognises_our_serve_config_and_funnel() {
        let mut s = TailscaleStatus { dns_name: Some("pc.t.ts.net".into()), state: "Running".into(), installed: true, ..Default::default() };
        let ours: Value = serde_json::from_str(
            r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"pc.t.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8732"}}}}}"#,
        )
        .unwrap();
        apply_serve_status(&mut s, &ours, 8732);
        assert!(s.serving && !s.port_in_use && !s.funnel);

        let other: Value = serde_json::from_str(
            r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"pc.t.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}},"AllowFunnel":{"pc.t.ts.net:443":true}}"#,
        )
        .unwrap();
        apply_serve_status(&mut s, &other, 8732);
        assert!(!s.serving && s.port_in_use && s.funnel);

        apply_serve_status(&mut s, &Value::Null, 8732);
        assert!(!s.serving && !s.port_in_use);
    }

    #[test]
    fn finds_the_approval_link() {
        let out = "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc123\n";
        assert_eq!(approval_url(out).as_deref(), Some("https://login.tailscale.com/f/serve?node=abc123"));
        assert_eq!(approval_url("all good"), None);
    }
}
