//! Who may talk to the media server and how sign-in is protected. The server is meant for the home
//! network and Tailscale only; connections from the internet are refused even if a router forwards
//! the port.

use std::collections::HashMap;
use std::net::IpAddr;
use std::time::{Duration, Instant};

/// Home-network, loopback and Tailscale addresses.
pub fn peer_allowed(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                // Shared address space; Tailscale gives devices 100.64.0.0/10 addresses.
                || (a == 100 && (64..=127).contains(&b))
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return peer_allowed(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            v6.is_loopback()
                // Unique local (fc00::/7, includes Tailscale's fd7a:115c:a1e0::/48) and link-local.
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
        }
    }
}

fn host_name(host: &str) -> &str {
    let host = host.trim();
    if let Some(rest) = host.strip_prefix('[') {
        return rest.split(']').next().unwrap_or_default();
    }
    match host.rsplit_once(':') {
        Some((name, port)) if port.chars().all(|c| c.is_ascii_digit()) && !name.contains(':') => name,
        _ => host,
    }
}

/// Blocks DNS rebinding: a website's own domain pointed at this machine can't talk to the server.
/// Allowed: IP addresses, `localhost`, single-label computer names, and local or Tailscale names.
pub fn host_allowed(host: Option<&str>) -> bool {
    let Some(host) = host else { return true }; // HTTP/1.0 clients such as some TVs
    let name = host_name(host).trim_end_matches('.').to_ascii_lowercase();
    if name.is_empty() {
        return false;
    }
    if name.parse::<IpAddr>().is_ok() || name == "localhost" || !name.contains('.') {
        return true;
    }
    [".local", ".ts.net", ".home.arpa", ".lan", ".localhost"].iter().any(|s| name.ends_with(s))
}

/// API requests from a browser must come from the TruongFlix page itself. Behind Tailscale Serve
/// (which connects from this machine) the page's origin is this device's own `*.ts.net` address.
pub fn origin_allowed(
    origin: Option<&str>,
    host: Option<&str>,
    forwarded_host: Option<&str>,
    via_loopback: bool,
    tailnet_name: Option<&str>,
) -> bool {
    let Some(origin) = origin else { return true };
    let Some(rest) = origin.strip_prefix("http://").or_else(|| origin.strip_prefix("https://")) else {
        return false;
    };
    let origin_host = rest.trim_end_matches('/');
    let same = |h: Option<&str>| h.is_some_and(|h| origin_host.eq_ignore_ascii_case(h.trim()));
    let own_tailnet = tailnet_name
        .map(|n| n.trim().trim_end_matches('.'))
        .filter(|n| !n.is_empty())
        .is_some_and(|n| host_name(origin_host).trim_end_matches('.').eq_ignore_ascii_case(n));
    same(host) || (via_loopback && (same(forwarded_host) || own_tailnet))
}

/// Forwarding headers are only believed from Tailscale Serve, which connects from this machine.
/// Serve appends the real client to `X-Forwarded-For`, so the last entry is the one it added.
pub fn forwarded_ip(peer: IpAddr, forwarded_for: Option<&str>) -> Option<IpAddr> {
    if !peer.is_loopback() {
        return None;
    }
    forwarded_for?.rsplit(',').next()?.trim().parse().ok()
}

/// Who wrong-code lockouts apply to: the device behind Tailscale Serve (its tailnet address, or
/// the signed-in Tailscale user), otherwise the connecting address.
pub fn client_key(peer: IpAddr, tailscale_login: Option<&str>, forwarded_for: Option<&str>) -> String {
    if let Some(ip) = forwarded_ip(peer, forwarded_for) {
        return ip.to_string();
    }
    if peer.is_loopback() {
        if let Some(login) = tailscale_login.map(str::trim).filter(|l| !l.is_empty()) {
            return format!("tailscale:{}", login.to_ascii_lowercase());
        }
    }
    peer.to_string()
}

pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut diff = (a.len() ^ b.len()) as u8;
    for i in 0..a.len().max(b.len()) {
        diff |= a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0);
    }
    diff == 0
}

/// "iPhone · Safari" from a User-Agent, for the signed-in devices list.
pub fn describe_device(user_agent: &str) -> String {
    let ua = user_agent;
    let device = if ua.contains("iPhone") {
        "iPhone"
    } else if ua.contains("iPad") {
        "iPad"
    } else if ua.contains("Android") {
        if ua.contains("Mobile") { "Android phone" } else { "Android tablet" }
    } else if ua.contains("CrOS") {
        "Chromebook"
    } else if ua.contains("Macintosh") {
        "Mac"
    } else if ua.contains("Windows") {
        "Windows PC"
    } else if ua.contains("Linux") {
        "Linux"
    } else {
        "Browser"
    };
    let browser = if ua.contains("Edg/") {
        "Edge"
    } else if ua.contains("Firefox/") || ua.contains("FxiOS") {
        "Firefox"
    } else if ua.contains("Chrome/") || ua.contains("CriOS") {
        "Chrome"
    } else if ua.contains("Safari/") {
        "Safari"
    } else {
        ""
    };
    if browser.is_empty() { device.into() } else { format!("{device} · {browser}") }
}

pub const MAX_FAILURES_PER_DEVICE: usize = 5;
pub const DEVICE_LOCKOUT: Duration = Duration::from_secs(15 * 60);
/// Wrong codes from all devices within an hour before sign-in pauses until a new code is made.
pub const MAX_FAILURES_TOTAL: usize = 20;
const FAILURE_WINDOW: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, PartialEq, Eq)]
pub enum LoginCheck {
    Allowed,
    /// Too many wrong codes from this address; try again after this long.
    Locked(Duration),
    /// Too many wrong codes overall; a new access code is needed.
    Paused,
}

/// Wrong-code tracking. Five wrong codes lock that device out for 15 minutes, and twenty in an
/// hour from anywhere pause sign-in until a new code is made, so a 6-digit code can't be guessed.
#[derive(Default)]
pub struct LoginGuard {
    per_device: HashMap<String, Vec<Instant>>,
    recent: Vec<Instant>,
    paused: bool,
}

impl LoginGuard {
    pub fn paused(&self) -> bool {
        self.paused
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn check(&mut self, key: &str, now: Instant) -> LoginCheck {
        if self.paused {
            return LoginCheck::Paused;
        }
        self.per_device.retain(|_, f| f.last().is_some_and(|t| now.duration_since(*t) < DEVICE_LOCKOUT));
        let Some(failures) = self.per_device.get_mut(key) else { return LoginCheck::Allowed };
        failures.retain(|t| now.duration_since(*t) < DEVICE_LOCKOUT);
        if failures.len() >= MAX_FAILURES_PER_DEVICE {
            let oldest = failures[0];
            return LoginCheck::Locked(DEVICE_LOCKOUT.saturating_sub(now.duration_since(oldest)));
        }
        LoginCheck::Allowed
    }

    /// Records a wrong code; returns how many tries this device has left.
    pub fn failed(&mut self, key: &str, now: Instant) -> usize {
        self.recent.retain(|t| now.duration_since(*t) < FAILURE_WINDOW);
        self.recent.push(now);
        if self.recent.len() >= MAX_FAILURES_TOTAL {
            self.paused = true;
        }
        let failures = self.per_device.entry(key.to_string()).or_default();
        failures.retain(|t| now.duration_since(*t) < DEVICE_LOCKOUT);
        failures.push(now);
        MAX_FAILURES_PER_DEVICE.saturating_sub(failures.len())
    }

    pub fn succeeded(&mut self, key: &str) {
        self.per_device.remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn only_home_network_and_tailscale_peers_are_allowed() {
        for ok in ["127.0.0.1", "192.168.1.20", "10.0.0.5", "172.20.1.1", "169.254.3.4", "100.101.102.103", "::1", "fe80::1", "fd7a:115c:a1e0::1", "::ffff:192.168.1.2"] {
            assert!(peer_allowed(ip(ok)), "{ok}");
        }
        for bad in ["75.164.77.206", "8.8.8.8", "100.128.0.1", "172.32.0.1", "2001:4860::1", "::ffff:8.8.8.8"] {
            assert!(!peer_allowed(ip(bad)), "{bad}");
        }
    }

    #[test]
    fn rebinding_hosts_are_rejected() {
        for ok in ["192.168.1.5:8732", "[fe80::1]:8732", "localhost:8732", "my-pc:8732", "my-pc.local", "pc.tailnet-123.ts.net", "nas.home.arpa"] {
            assert!(host_allowed(Some(ok)), "{ok}");
        }
        for bad in ["evil.example:8732", "attacker.com", "", "truongflix.example.com"] {
            assert!(!host_allowed(Some(bad)), "{bad}");
        }
        assert!(host_allowed(None));
    }

    #[test]
    fn api_origins_must_match_the_host() {
        let lan = Some("192.168.1.5:8732");
        let me = Some("pc.tail1.ts.net");
        assert!(origin_allowed(None, lan, None, false, None));
        assert!(origin_allowed(Some("http://192.168.1.5:8732"), lan, None, false, None));
        assert!(origin_allowed(Some("https://pc.tail1.ts.net"), Some("pc.tail1.ts.net"), None, true, None));
        assert!(origin_allowed(Some("https://pc.tail1.ts.net"), Some("127.0.0.1:8732"), Some("pc.tail1.ts.net"), true, None));
        assert!(origin_allowed(Some("https://pc.tail1.ts.net"), Some("127.0.0.1:8732"), None, true, me));
        assert!(origin_allowed(Some("https://PC.tail1.ts.net"), Some("127.0.0.1:8732"), None, true, Some("pc.tail1.ts.net.")));
        // Another tailnet's device, or ours before its name is known.
        assert!(!origin_allowed(Some("https://other.tail9.ts.net"), Some("127.0.0.1:8732"), None, true, me));
        assert!(!origin_allowed(Some("https://pc.tail1.ts.net"), Some("127.0.0.1:8732"), None, true, None));
        assert!(!origin_allowed(Some("https://pc.tail1.ts.net"), lan, None, false, me));
        // Forwarding headers only count when Serve (loopback) sent them.
        assert!(!origin_allowed(Some("https://evil.example"), lan, Some("evil.example"), false, me));
        assert!(!origin_allowed(Some("https://evil.example"), lan, None, false, me));
        assert!(!origin_allowed(Some("https://evil.example"), Some("127.0.0.1:8732"), None, true, me));
        assert!(!origin_allowed(Some("null"), lan, None, false, me));
    }

    #[test]
    fn lockouts_follow_the_tailscale_client_behind_serve() {
        let lo = ip("127.0.0.1");
        assert_eq!(client_key(lo, Some("Ann@example.com"), Some("100.70.1.2")), "100.70.1.2");
        assert_eq!(client_key(lo, None, Some("1.2.3.4, 100.70.1.3")), "100.70.1.3");
        assert_eq!(client_key(lo, Some("Ann@example.com"), None), "tailscale:ann@example.com");
        assert_eq!(client_key(lo, None, None), "127.0.0.1");
        // Headers from anyone but Serve are ignored.
        assert_eq!(client_key(ip("192.168.1.30"), Some("ann@example.com"), Some("100.70.1.2")), "192.168.1.30");
        assert_eq!(forwarded_ip(ip("192.168.1.30"), Some("100.70.1.2")), None);

        let mut guard = LoginGuard::default();
        let t = Instant::now();
        for _ in 0..MAX_FAILURES_PER_DEVICE {
            guard.failed(&client_key(lo, None, Some("100.70.1.2")), t);
        }
        assert!(matches!(guard.check("100.70.1.2", t), LoginCheck::Locked(_)));
        assert_eq!(guard.check(&client_key(lo, None, Some("100.70.1.3")), t), LoginCheck::Allowed);
        assert_eq!(guard.check(&client_key(lo, None, None), t), LoginCheck::Allowed);
    }

    #[test]
    fn codes_compare_in_constant_time() {
        assert!(constant_time_eq("482913", "482913"));
        assert!(!constant_time_eq("482913", "482914"));
        assert!(!constant_time_eq("482913", "48291"));
        assert!(!constant_time_eq("", "1"));
    }

    #[test]
    fn devices_lock_out_and_too_many_failures_pause_sign_in() {
        let mut guard = LoginGuard::default();
        let t = Instant::now();
        let phone = "192.168.1.30";
        for left in (0..MAX_FAILURES_PER_DEVICE).rev() {
            assert_eq!(guard.check(phone, t), LoginCheck::Allowed);
            assert_eq!(guard.failed(phone, t), left);
        }
        assert!(matches!(guard.check(phone, t), LoginCheck::Locked(d) if d <= DEVICE_LOCKOUT));
        assert_eq!(guard.check(phone, t + DEVICE_LOCKOUT), LoginCheck::Allowed);

        let mut guard = LoginGuard::default();
        for i in 0..MAX_FAILURES_TOTAL {
            guard.failed(&format!("192.168.1.{}", i % 250 + 1), t);
        }
        assert_eq!(guard.check("192.168.1.251", t), LoginCheck::Paused);
        guard.reset();
        assert_eq!(guard.check("192.168.1.251", t), LoginCheck::Allowed);
    }

    #[test]
    fn device_names_are_readable() {
        assert_eq!(describe_device("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"), "iPhone · Safari");
        assert_eq!(describe_device("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0"), "Windows PC · Edge");
        assert_eq!(describe_device("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36"), "Android phone · Chrome");
        assert_eq!(describe_device(""), "Browser");
    }
}
