//! Network shares (NAS): recognises media folders that live on SMB/AFP/NFS shares or mapped
//! drives, remembers how to reach them, and reconnects them on demand, waking a sleeping NAS
//! with Wake-on-LAN first.

use serde::{Deserialize, Serialize};
use std::net::{TcpStream, ToSocketAddrs, UdpSocket};
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ShareInfo {
    /// Where the share appears locally ("/Volumes/Media", "Z:", or the UNC root).
    pub mount_point: String,
    /// How to reconnect it ("smb://user@nas.local/Media", "\\\\nas\\Media", …).
    pub url: String,
    pub host: String,
    /// "smb" | "afp" | "nfs" | "windows"
    pub kind: String,
    /// NAS network-card address for Wake-on-LAN (detected while it's reachable).
    pub mac: Option<String>,
}

fn service_port(kind: &str) -> u16 {
    match kind {
        "afp" => 548,
        "nfs" => 2049,
        _ => 445,
    }
}

fn reachable(host: &str, port: u16, timeout: Duration) -> bool {
    let Ok(addrs) = (host, port).to_socket_addrs() else { return false };
    addrs.into_iter().any(|a| TcpStream::connect_timeout(&a, timeout).is_ok())
}

/// MAC address of `host` from the ARP cache (it must be on the local network and reachable).
fn mac_of(host: &str, port: u16) -> Option<String> {
    let ip = (host, port).to_socket_addrs().ok()?.find(|a| a.is_ipv4())?.ip().to_string();
    let _ = TcpStream::connect_timeout(&(ip.as_str(), port).to_socket_addrs().ok()?.next()?, Duration::from_secs(2));
    let mut cmd = std::process::Command::new("arp");
    if cfg!(windows) {
        cmd.args(["-a", &ip]);
    } else {
        cmd.args(["-n", &ip]);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = String::from_utf8_lossy(&cmd.output().ok()?.stdout).into_owned();
    parse_mac(&out)
}

fn parse_mac(arp_output: &str) -> Option<String> {
    arp_output.split_whitespace().find_map(|token| {
        let parts: Vec<&str> = token.split([':', '-']).collect();
        if parts.len() != 6 || !parts.iter().all(|p| (1..=2).contains(&p.len()) && p.chars().all(|c| c.is_ascii_hexdigit())) {
            return None;
        }
        let mac = parts.iter().map(|p| format!("{:0>2}", p.to_lowercase())).collect::<Vec<_>>().join(":");
        (mac != "ff:ff:ff:ff:ff:ff" && mac != "00:00:00:00:00:00").then_some(mac)
    })
}

fn mac_bytes(mac: &str) -> Option<[u8; 6]> {
    let parts: Vec<u8> = mac.split([':', '-']).filter_map(|p| u8::from_str_radix(p, 16).ok()).collect();
    parts.try_into().ok()
}

/// Wake-on-LAN magic packet: 6 × 0xFF, then the MAC 16 times, broadcast on ports 9 and 7.
fn send_magic_packet(mac: [u8; 6]) -> std::io::Result<()> {
    let mut packet = vec![0xFFu8; 6];
    for _ in 0..16 {
        packet.extend_from_slice(&mac);
    }
    let socket = UdpSocket::bind("0.0.0.0:0")?;
    socket.set_broadcast(true)?;
    for port in [9, 7] {
        socket.send_to(&packet, ("255.255.255.255", port))?;
    }
    Ok(())
}

/// Which media folders are on network shares (None = local disk or currently unreachable).
#[tauri::command]
pub async fn share_info(paths: Vec<String>) -> Vec<Option<ShareInfo>> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .iter()
            .map(|p| {
                let mut info = platform::share_for(Path::new(p))?;
                info.mac = mac_of(&info.host, service_port(&info.kind));
                Some(info)
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[derive(Clone, Serialize)]
struct NasProgress {
    host: String,
    stage: &'static str,
}

/// Makes `share` available: reconnects it, and with `wake` first sends Wake-on-LAN and waits for
/// the NAS to come online. Returns the stage reached ("ready").
#[tauri::command]
pub async fn connect_share(app: AppHandle, share: ShareInfo, wake: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let progress = |stage: &'static str| {
            let _ = app.emit("nas-progress", NasProgress { host: share.host.clone(), stage });
        };
        if Path::new(&share.mount_point).is_dir() {
            return Ok("ready".into());
        }
        let port = service_port(&share.kind);
        if !reachable(&share.host, port, Duration::from_secs(2)) {
            let mac = share.mac.as_deref().and_then(mac_bytes);
            match (wake, mac) {
                (true, Some(mac)) => {
                    progress("waking");
                    let started = Instant::now();
                    let mut last_packet = Instant::now() - Duration::from_secs(10);
                    loop {
                        if last_packet.elapsed() >= Duration::from_secs(5) {
                            send_magic_packet(mac).map_err(|e| format!("Couldn’t send Wake-on-LAN: {e}"))?;
                            last_packet = Instant::now();
                        }
                        if reachable(&share.host, port, Duration::from_secs(2)) {
                            break;
                        }
                        if started.elapsed() > Duration::from_secs(120) {
                            return Err(format!("{} didn’t wake up within 2 minutes", share.host));
                        }
                    }
                }
                (true, None) => return Err(format!("{} is offline and its Wake-on-LAN address isn’t known yet", share.host)),
                (false, _) => return Err(format!("{} is offline", share.host)),
            }
        }
        progress("connecting");
        platform::mount(&share)?;
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if Path::new(&share.mount_point).is_dir() {
                progress("ready");
                return Ok("ready".into());
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        Err(format!("{} is online but {} didn’t appear", share.host, share.mount_point))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(target_os = "macos")]
mod platform {
    use super::ShareInfo;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;
    use std::ffi::{c_void, CStr, CString};
    use std::path::Path;

    #[link(name = "NetFS", kind = "framework")]
    extern "C" {
        fn NetFSMountURLSync(
            url: *const c_void,
            mountpath: *const c_void,
            user: *const c_void,
            passwd: *const c_void,
            open_options: *const c_void,
            mount_options: *const c_void,
            mountpoints: *mut *const c_void,
        ) -> i32;
    }

    pub fn share_for(path: &Path) -> Option<ShareInfo> {
        let c = CString::new(path.to_string_lossy().as_bytes()).ok()?;
        let mut st: libc::statfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statfs(c.as_ptr(), &mut st) } != 0 {
            return None;
        }
        let field = |f: &[libc::c_char]| unsafe { CStr::from_ptr(f.as_ptr()) }.to_string_lossy().into_owned();
        let (fstype, from, on) = (field(&st.f_fstypename), field(&st.f_mntfromname), field(&st.f_mntonname));
        let (kind, url, host) = match fstype.as_str() {
            // "//user@host/share"
            "smbfs" | "afpfs" => {
                let scheme = if fstype == "smbfs" { "smb" } else { "afp" };
                let rest = from.trim_start_matches('/');
                let host = rest.split('/').next()?.rsplit('@').next()?.to_string();
                (scheme, format!("{scheme}://{rest}"), host)
            }
            // "host:/export"
            "nfs" => {
                let (host, export) = from.split_once(':')?;
                ("nfs", format!("nfs://{host}{export}"), host.to_string())
            }
            _ => return None,
        };
        Some(ShareInfo { mount_point: on, url, host, kind: kind.into(), mac: None })
    }

    /// Mounts with NetFS, which uses saved Keychain credentials (and asks if there are none).
    pub fn mount(share: &ShareInfo) -> Result<(), String> {
        unsafe {
            let s = NSString::from_str(&share.url);
            let url: *mut AnyObject = msg_send![class!(NSURL), URLWithString: &*s];
            if url.is_null() {
                return Err(format!("Invalid share address: {}", share.url));
            }
            let mut points: *const c_void = std::ptr::null();
            let null = std::ptr::null();
            let status = NetFSMountURLSync(url as *const c_void, null, null, null, null, null, &mut points);
            match status {
                0 | 17 => Ok(()), // 17 = EEXIST: already mounted
                code => Err(format!("Couldn’t connect to {} (error {code})", share.url)),
            }
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::ShareInfo;
    use std::path::Path;
    use windows_sys::Win32::NetworkManagement::WNet::{WNetAddConnection2W, WNetGetConnectionW, NETRESOURCEW, RESOURCETYPE_DISK};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn host_of(unc: &str) -> Option<String> {
        unc.trim_start_matches('\\').split('\\').next().filter(|h| !h.is_empty()).map(str::to_owned)
    }

    pub fn share_for(path: &Path) -> Option<ShareInfo> {
        let p = path.to_string_lossy();
        if let Some(rest) = p.strip_prefix(r"\\") {
            // \\host\share\…
            let mut parts = rest.split('\\');
            let (host, share) = (parts.next()?, parts.next()?);
            let root = format!(r"\\{host}\{share}");
            return Some(ShareInfo { mount_point: root.clone(), url: root, host: host.into(), kind: "windows".into(), mac: None });
        }
        let drive: String = p.chars().take(2).collect();
        if drive.len() != 2 || !drive.ends_with(':') {
            return None;
        }
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        let status = unsafe { WNetGetConnectionW(wide(&drive).as_ptr(), buf.as_mut_ptr(), &mut len) };
        if status != 0 {
            return None; // local drive
        }
        let remote = String::from_utf16_lossy(&buf[..buf.iter().position(|c| *c == 0).unwrap_or(0)]);
        Some(ShareInfo { mount_point: format!("{drive}\\"), host: host_of(&remote)?, url: remote, kind: "windows".into(), mac: None })
    }

    /// Reconnects the mapped drive (or the UNC share) with Windows' saved credentials.
    pub fn mount(share: &ShareInfo) -> Result<(), String> {
        let mut remote = wide(&share.url);
        let local = share.mount_point.trim_end_matches('\\').to_string();
        let mut local_w = wide(&local);
        let is_drive = local.len() == 2 && local.ends_with(':');
        let resource = NETRESOURCEW {
            dwScope: 0,
            dwType: RESOURCETYPE_DISK,
            dwDisplayType: 0,
            dwUsage: 0,
            lpLocalName: if is_drive { local_w.as_mut_ptr() } else { std::ptr::null_mut() },
            lpRemoteName: remote.as_mut_ptr(),
            lpComment: std::ptr::null_mut(),
            lpProvider: std::ptr::null_mut(),
        };
        match unsafe { WNetAddConnection2W(&resource, std::ptr::null(), std::ptr::null(), 0) } {
            0 | 85 | 1219 => Ok(()), // 85: drive letter already in use (connected), 1219: existing session
            code => Err(format!("Couldn’t connect to {} (error {code})", share.url)),
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::ShareInfo;
    use std::path::Path;
    pub fn share_for(_path: &Path) -> Option<ShareInfo> {
        None
    }
    pub fn mount(_share: &ShareInfo) -> Result<(), String> {
        Err("Not supported on this platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_arp_output_from_both_platforms() {
        assert_eq!(parse_mac("? (192.168.1.20) at 0:11:32:a:bb:cc on en0 ifscope [ethernet]").as_deref(), Some("00:11:32:0a:bb:cc"));
        assert_eq!(parse_mac("  192.168.1.20          00-11-32-aa-bb-cc     dynamic").as_deref(), Some("00:11:32:aa:bb:cc"));
        assert_eq!(parse_mac("? (192.168.1.20) at (incomplete) on en0"), None);
        assert_eq!(mac_bytes("00:11:32:0a:bb:cc"), Some([0, 0x11, 0x32, 0x0a, 0xbb, 0xcc]));
    }

    #[test]
    fn local_disk_is_not_a_share() {
        assert_eq!(platform::share_for(&std::env::temp_dir()), None);
    }
}
