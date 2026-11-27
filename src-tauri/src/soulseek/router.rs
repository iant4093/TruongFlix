//! Opens the Soulseek listening port on the home router (UPnP), the way torrent apps do, so other
//! people can connect to us. Without it nobody can: someone who is behind a router too then
//! can't send us anything ("the upload failed on the other side"), since neither side can reach
//! the other. Only the home network is spoken to (the router); nothing is asked of the user.
//!
//! The opening lasts an hour and is renewed while signed in, so it lapses by itself if the app
//! is killed; it's closed on sign-out and when the app quits.

use reqwest::Url;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long each opening lasts; it's renewed at half that.
const LEASE: u32 = 3600;
/// What the router lists the opening as.
const DESCRIPTION: &str = "Soulseek";
/// The router services that can open a port, in order of preference.
const SERVICES: [&str; 3] = [
    "urn:schemas-upnp-org:service:WANIPConnection:2",
    "urn:schemas-upnp-org:service:WANIPConnection:1",
    "urn:schemas-upnp-org:service:WANPPPConnection:1",
];
const SSDP: SocketAddrV4 = SocketAddrV4::new(Ipv4Addr::new(239, 255, 255, 250), 1900);

/// A router's port-opening service, and our address on the network it serves.
#[derive(Clone, Debug, PartialEq)]
struct Gateway {
    control: Url,
    service: String,
    local: Ipv4Addr,
}

/// The port that's open, and on which router.
struct Open {
    port: u16,
    gateway: Gateway,
}

static OPEN: Mutex<Option<Open>> = Mutex::new(None);
/// The port being kept open (0: none). Bumping `TURN` stops the thread that keeps it open.
static KEPT: Mutex<u16> = Mutex::new(0);
static TURN: AtomicU64 = AtomicU64::new(0);

/// Keeps `port` open on the router while signed in (a call for the port already kept is a no-op).
pub fn keep_open(port: u16) {
    if port == 0 {
        return close();
    }
    {
        let mut kept = KEPT.lock().unwrap();
        if *kept == port {
            return;
        }
        *kept = port;
    }
    let turn = TURN.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        // A port opened before (the listening port was changed) is closed first.
        if let Some(old) = OPEN.lock().unwrap().take() {
            let _ = soap(&old.gateway, "DeletePortMapping", &format!("<NewRemoteHost></NewRemoteHost><NewExternalPort>{}</NewExternalPort><NewProtocol>TCP</NewProtocol>", old.port));
        }
        let current = || TURN.load(Ordering::SeqCst) == turn;
        let mut told = false;
        let mut gateway: Option<Gateway> = None;
        while current() {
            let result = (|| -> Result<(), String> {
                let found = match &gateway {
                    Some(g) => g.clone(),
                    None => find_gateway()?,
                };
                gateway = Some(found.clone());
                add(&found, port)?;
                if current() {
                    *OPEN.lock().unwrap() = Some(Open { port, gateway: found });
                }
                Ok(())
            })();
            match result {
                Ok(()) if !told => {
                    told = true;
                    super::note(format!("Your router opened port {port}, so other people can connect to you"));
                }
                Err(e) => {
                    // A router that's forgotten us (rebooted, new address) is looked for afresh.
                    gateway = None;
                    if !told {
                        told = true;
                        super::note(format!("Your router didn’t open port {port} ({e}); people who are behind a router too can’t send to you"));
                    }
                }
                _ => {}
            }
            let renew = Instant::now() + Duration::from_secs(LEASE as u64 / 2);
            while current() && Instant::now() < renew {
                std::thread::sleep(Duration::from_secs(1));
            }
        }
    });
}

/// Closes the port (on sign-out and when the app quits).
pub fn close() {
    *KEPT.lock().unwrap() = 0;
    TURN.fetch_add(1, Ordering::SeqCst);
    if let Some(open) = OPEN.lock().unwrap().take() {
        let _ = soap(&open.gateway, "DeletePortMapping", &format!("<NewRemoteHost></NewRemoteHost><NewExternalPort>{}</NewExternalPort><NewProtocol>TCP</NewProtocol>", open.port));
    }
}

/// Our address on the home network: the one the system would send from to reach the internet
/// (no packet is sent).
fn local_address() -> Result<Ipv4Addr, String> {
    let probe = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    probe.connect("192.0.2.1:9").map_err(|_| "no network".to_string())?;
    match probe.local_addr() {
        Ok(SocketAddr::V4(a)) if !a.ip().is_unspecified() => Ok(*a.ip()),
        _ => Err("no network".into()),
    }
}

/// Finds the router: asks the network who can open ports, then reads that device's description.
fn find_gateway() -> Result<Gateway, String> {
    let local = local_address()?;
    let socket = socket2::Socket::new(socket2::Domain::IPV4, socket2::Type::DGRAM, Some(socket2::Protocol::UDP)).map_err(|e| e.to_string())?;
    // Sent from the home network's interface: with a VPN up, the system may otherwise send it
    // into the tunnel, where no router answers.
    socket.set_multicast_if_v4(&local).map_err(|e| e.to_string())?;
    socket.bind(&SocketAddr::V4(SocketAddrV4::new(local, 0)).into()).map_err(|e| e.to_string())?;
    let socket: UdpSocket = socket.into();
    socket.set_read_timeout(Some(Duration::from_millis(500))).map_err(|e| e.to_string())?;
    for kind in ["urn:schemas-upnp-org:device:InternetGatewayDevice:1", "urn:schemas-upnp-org:device:InternetGatewayDevice:2"] {
        let search = format!("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {kind}\r\n\r\n");
        let _ = socket.send_to(search.as_bytes(), SSDP);
    }
    let until = Instant::now() + Duration::from_secs(3);
    let mut buf = [0u8; 2048];
    let mut tried = Vec::new();
    while Instant::now() < until {
        let Ok((n, _)) = socket.recv_from(&mut buf) else { continue };
        let Some(location) = ssdp_location(&String::from_utf8_lossy(&buf[..n])) else { continue };
        if tried.contains(&location) {
            continue;
        }
        tried.push(location.clone());
        let Ok(url) = Url::parse(&location) else { continue };
        let Ok(description) = http(|c| c.get(url.clone())) else { continue };
        if let Some((service, control)) = port_service(&url, &description) {
            return Ok(Gateway { control, service, local });
        }
    }
    Err(if tried.is_empty() { "it didn’t answer: UPnP may be off" } else { "it can’t open ports" }.into())
}

/// The LOCATION of an SSDP answer.
fn ssdp_location(answer: &str) -> Option<String> {
    answer.lines().find_map(|l| {
        let (key, value) = l.split_once(':')?;
        key.trim().eq_ignore_ascii_case("location").then(|| value.trim().to_string())
    })
}

/// The best port-opening service in a device description, and the full address to control it.
fn port_service(location: &Url, description: &str) -> Option<(String, Url)> {
    let tag = |block: &str, name: &str| -> Option<String> {
        let start = block.find(&format!("<{name}>"))? + name.len() + 2;
        let end = start + block[start..].find(&format!("</{name}>"))?;
        Some(block[start..end].trim().to_string())
    };
    let base = tag(description, "URLBase").and_then(|b| Url::parse(&b).ok()).unwrap_or_else(|| location.clone());
    let services: Vec<(String, String)> = description
        .split("<service>")
        .skip(1)
        .filter_map(|block| Some((tag(block, "serviceType")?, tag(block, "controlURL")?)))
        .collect();
    SERVICES.iter().find_map(|wanted| {
        let (kind, control) = services.iter().find(|(kind, _)| kind == wanted)?;
        Some((kind.clone(), base.join(control).ok()?))
    })
}

fn add(gateway: &Gateway, port: u16) -> Result<(), String> {
    let args = |lease: u32| {
        format!(
            "<NewRemoteHost></NewRemoteHost><NewExternalPort>{port}</NewExternalPort><NewProtocol>TCP</NewProtocol><NewInternalPort>{port}</NewInternalPort><NewInternalClient>{}</NewInternalClient><NewEnabled>1</NewEnabled><NewPortMappingDescription>{DESCRIPTION}</NewPortMappingDescription><NewLeaseDuration>{lease}</NewLeaseDuration>",
            gateway.local
        )
    };
    match soap(gateway, "AddPortMapping", &args(LEASE)) {
        // Some routers only open ports for good; it's closed by hand on sign-out and quit.
        Err(e) if e.contains("725") => soap(gateway, "AddPortMapping", &args(0)).map(|_| ()),
        Err(e) if e.contains("718") => Err("another device on your network already has it".into()),
        other => other.map(|_| ()),
    }
}

/// Calls a router action; an error names the router's error code when it gives one.
fn soap(gateway: &Gateway, action: &str, args: &str) -> Result<String, String> {
    let service = &gateway.service;
    let body = format!(
        "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:{action} xmlns:u=\"{service}\">{args}</u:{action}></s:Body></s:Envelope>"
    );
    http(|c| {
        c.post(gateway.control.clone())
            .header("Content-Type", "text/xml; charset=\"utf-8\"")
            .header("SOAPAction", format!("\"{service}#{action}\""))
            .body(body.clone())
    })
}

/// Sends one request to the router (blocking) and returns the body of a successful answer.
fn http(request: impl Fn(&reqwest::Client) -> reqwest::RequestBuilder) -> Result<String, String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).no_proxy().build().map_err(|e| e.to_string())?;
    let sent = request(&client);
    tauri::async_runtime::block_on(async move {
        let response = sent.send().await.map_err(|_| "it didn’t answer".to_string())?;
        let ok = response.status().is_success();
        let text = response.text().await.unwrap_or_default();
        if ok {
            Ok(text)
        } else {
            let code = text.split("<errorCode>").nth(1).and_then(|s| s.split('<').next()).unwrap_or("?").trim().to_string();
            Err(format!("router error {code}"))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_where_the_router_describes_itself() {
        let answer = "HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=120\r\nLocation: http://192.168.0.1:1900/gatedesc.xml\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n";
        assert_eq!(ssdp_location(answer).as_deref(), Some("http://192.168.0.1:1900/gatedesc.xml"));
        assert_eq!(ssdp_location("HTTP/1.1 200 OK\r\nST: x\r\n\r\n"), None);
    }

    #[test]
    fn finds_the_port_opening_service_and_its_address() {
        let location = Url::parse("http://192.168.0.1:1900/gatedesc.xml").unwrap();
        let description = r#"<root><device><serviceList>
            <service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/l3f</controlURL></service>
            </serviceList><deviceList><device><deviceList><device><serviceList>
            <service><serviceType>urn:schemas-upnp-org:service:WANPPPConnection:1</serviceType><controlURL>/ppp</controlURL></service>
            <service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/upnp/control/WANIPConn1</controlURL></service>
            </serviceList></device></deviceList></device></deviceList></device></root>"#;
        let (service, control) = port_service(&location, description).unwrap();
        // The IP connection is preferred over PPP.
        assert_eq!(service, "urn:schemas-upnp-org:service:WANIPConnection:1");
        assert_eq!(control.as_str(), "http://192.168.0.1:1900/upnp/control/WANIPConn1");
        // A URLBase wins over where the description came from.
        let based = description.replace("<root>", "<root><URLBase>http://192.168.0.1:5000/</URLBase>");
        assert_eq!(port_service(&location, &based).unwrap().1.as_str(), "http://192.168.0.1:5000/upnp/control/WANIPConn1");
        // A device that can't open ports.
        assert!(port_service(&location, "<root><serviceList><service><serviceType>urn:x</serviceType><controlURL>/x</controlURL></service></serviceList></root>").is_none());
    }

    /// A pretend router: answers each request with the next of `replies` (status, body) and
    /// keeps what was asked.
    fn router(replies: Vec<(u16, &'static str)>) -> (Gateway, std::sync::Arc<Mutex<Vec<String>>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let asked = std::sync::Arc::new(Mutex::new(Vec::new()));
        let kept = asked.clone();
        std::thread::spawn(move || {
            for (status, body) in replies {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = Vec::new();
                let mut buf = [0u8; 4096];
                // Headers, then as much body as Content-Length says.
                loop {
                    let n = stream.read(&mut buf).unwrap();
                    request.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&request).to_string();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                kept.lock().unwrap().push(String::from_utf8_lossy(&request).to_string());
                let _ = write!(stream, "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            }
        });
        let gateway = Gateway { control: Url::parse(&format!("http://127.0.0.1:{port}/ctl")).unwrap(), service: SERVICES[1].into(), local: Ipv4Addr::new(192, 168, 0, 20) };
        (gateway, asked)
    }

    /// Against the real home router: opens a spare port, checks the router lists it, closes it.
    /// `cargo test --lib real_router -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_router_opens_and_closes_a_port() {
        let gateway = find_gateway().expect("router");
        println!("router service: {}", gateway.service);
        let listed = |port: u16| {
            soap(&gateway, "GetSpecificPortMappingEntry", &format!("<NewRemoteHost></NewRemoteHost><NewExternalPort>{port}</NewExternalPort><NewProtocol>TCP</NewProtocol>"))
                .is_ok_and(|r| r.contains(&gateway.local.to_string()))
        };
        add(&gateway, 47213).expect("opened");
        assert!(listed(47213));
        soap(&gateway, "DeletePortMapping", "<NewRemoteHost></NewRemoteHost><NewExternalPort>47213</NewExternalPort><NewProtocol>TCP</NewProtocol>").expect("closed");
        assert!(!listed(47213));
    }

    #[test]
    fn opens_the_port_for_an_hour_or_for_good_when_that_is_all_the_router_does() {
        let (gateway, asked) = router(vec![(200, "<ok/>")]);
        add(&gateway, 2234).unwrap();
        let request = asked.lock().unwrap()[0].clone();
        assert!(request.contains("SOAPAction: \"urn:schemas-upnp-org:service:WANIPConnection:1#AddPortMapping\"") || request.to_lowercase().contains("soapaction: \"urn:schemas-upnp-org:service:wanipconnection:1#addportmapping\""));
        for part in ["<NewExternalPort>2234</NewExternalPort>", "<NewInternalPort>2234</NewInternalPort>", "<NewInternalClient>192.168.0.20</NewInternalClient>", "<NewLeaseDuration>3600</NewLeaseDuration>", "<NewProtocol>TCP</NewProtocol>"] {
            assert!(request.contains(part), "{part}");
        }

        let (gateway, asked) = router(vec![(500, "<s:Fault><detail><UPnPError><errorCode>725</errorCode></UPnPError></detail></s:Fault>"), (200, "<ok/>")]);
        add(&gateway, 2234).unwrap();
        assert!(asked.lock().unwrap()[1].contains("<NewLeaseDuration>0</NewLeaseDuration>"));

        let (gateway, _) = router(vec![(500, "<errorCode>718</errorCode>")]);
        assert_eq!(add(&gateway, 2234).unwrap_err(), "another device on your network already has it");
    }
}
