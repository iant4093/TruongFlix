//! Casting to TVs on the home network: Chromecast (Cast v2 protocol) and DLNA/UPnP renderers
//! (most smart TVs). Devices fetch the media from our local server (`stream.rs`); this module
//! finds them, tells them what to play, controls playback and reports `cast-status` events.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs, UdpSocket};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CastDevice {
    pub id: String,
    pub name: String,
    /// "chromecast" | "dlna"
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub model: Option<String>,
    /// DLNA control endpoints.
    pub av_transport: Option<String>,
    pub rendering: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CastMedia {
    pub url: String,
    pub content_type: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub image: Option<String>,
    /// Where to start (direct streams; converted streams already start there).
    pub start: f64,
    pub duration: f64,
}

#[derive(Clone, Serialize)]
struct Status {
    /// "connecting" | "buffering" | "playing" | "paused" | "idle" | "ended" | "error"
    state: String,
    time: f64,
    duration: f64,
    message: Option<String>,
}

/// Where status updates go (the app's `cast-status` event; a recorder in tests).
type Reporter = std::sync::Arc<dyn Fn(&str, f64, f64, Option<String>) + Send + Sync>;

fn reporter(app: AppHandle) -> Reporter {
    std::sync::Arc::new(move |state, time, duration, message| {
        let _ = app.emit("cast-status", Status { state: state.into(), time, duration, message });
    })
}

fn emit(r: &Reporter, state: &str, time: f64, duration: f64, message: Option<String>) {
    r(state, time, duration, message);
}

enum Command {
    Play,
    Pause,
    Seek(f64),
    Volume(f64),
    Stop,
}

static SESSION: Mutex<Option<mpsc::Sender<Command>>> = Mutex::new(None);

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/// macOS: browse through the system's Bonjour service (mDNSResponder), which is how apps are
/// expected to do local discovery there (raw multicast sockets are restricted).
#[cfg(target_os = "macos")]
fn discover_chromecasts(timeout: Duration) -> Vec<CastDevice> {
    dnssd::browse("_googlecast._tcp", timeout)
        .into_iter()
        .filter_map(|svc| {
            let host = (svc.host.trim_end_matches('.'), svc.port).to_socket_addrs().ok()?.find(|a| a.is_ipv4())?.ip().to_string();
            Some(CastDevice {
                id: svc.txt.get("id").cloned().unwrap_or_else(|| svc.name.clone()),
                name: svc.txt.get("fn").cloned().unwrap_or_else(|| svc.name.clone()),
                kind: "chromecast".into(),
                host,
                port: svc.port,
                model: svc.txt.get("md").cloned(),
                av_transport: None,
                rendering: None,
            })
        })
        .fold(Vec::new(), |mut acc: Vec<CastDevice>, d| {
            if !acc.iter().any(|x| x.id == d.id) {
                acc.push(d);
            }
            acc
        })
}

#[cfg(target_os = "macos")]
mod dnssd {
    use std::collections::HashMap;
    use std::ffi::{c_char, c_int, c_void, CStr, CString};
    use std::time::{Duration, Instant};

    type Ref = *mut c_void;
    type BrowseReply = extern "C" fn(Ref, u32, u32, i32, *const c_char, *const c_char, *const c_char, *mut c_void);
    type ResolveReply = extern "C" fn(Ref, u32, u32, i32, *const c_char, *const c_char, u16, u16, *const u8, *mut c_void);

    extern "C" {
        fn DNSServiceBrowse(sd: *mut Ref, flags: u32, iface: u32, regtype: *const c_char, domain: *const c_char, cb: BrowseReply, ctx: *mut c_void) -> i32;
        fn DNSServiceResolve(sd: *mut Ref, flags: u32, iface: u32, name: *const c_char, regtype: *const c_char, domain: *const c_char, cb: ResolveReply, ctx: *mut c_void) -> i32;
        fn DNSServiceRefSockFD(sd: Ref) -> c_int;
        fn DNSServiceProcessResult(sd: Ref) -> i32;
        fn DNSServiceRefDeallocate(sd: Ref);
    }

    pub struct Service {
        pub name: String,
        pub host: String,
        pub port: u16,
        pub txt: HashMap<String, String>,
    }

    struct Found {
        name: String,
        regtype: String,
        domain: String,
        iface: u32,
    }

    extern "C" fn on_browse(_: Ref, _flags: u32, iface: u32, err: i32, name: *const c_char, regtype: *const c_char, domain: *const c_char, ctx: *mut c_void) {
        if err != 0 || name.is_null() {
            return;
        }
        let list = unsafe { &mut *(ctx as *mut Vec<Found>) };
        let s = |p: *const c_char| unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
        let found = Found { name: s(name), regtype: s(regtype), domain: s(domain), iface };
        if !list.iter().any(|f| f.name == found.name) {
            list.push(found);
        }
    }

    extern "C" fn on_resolve(_: Ref, _flags: u32, _iface: u32, err: i32, _full: *const c_char, host: *const c_char, port_be: u16, txt_len: u16, txt: *const u8, ctx: *mut c_void) {
        let out = unsafe { &mut *(ctx as *mut Option<(String, u16, HashMap<String, String>)>) };
        if err != 0 || host.is_null() {
            return;
        }
        let bytes = if txt.is_null() { &[][..] } else { unsafe { std::slice::from_raw_parts(txt, txt_len as usize) } };
        *out = Some((unsafe { CStr::from_ptr(host) }.to_string_lossy().into_owned(), u16::from_be(port_be), parse_txt(bytes)));
    }

    /// TXT records are length-prefixed "key=value" strings.
    fn parse_txt(mut bytes: &[u8]) -> HashMap<String, String> {
        let mut out = HashMap::new();
        while let Some((&len, rest)) = bytes.split_first() {
            let (entry, tail) = rest.split_at((len as usize).min(rest.len()));
            let text = String::from_utf8_lossy(entry);
            if let Some((k, v)) = text.split_once('=') {
                out.insert(k.to_lowercase(), v.to_string());
            }
            bytes = tail;
        }
        out
    }

    /// Runs `sd`'s callbacks until `deadline` (or `done()`).
    fn pump(sd: Ref, deadline: Instant, done: &dyn Fn() -> bool) {
        let fd = unsafe { DNSServiceRefSockFD(sd) };
        while !done() {
            let Some(left) = deadline.checked_duration_since(Instant::now()) else { break };
            let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
            let ready = unsafe { libc::poll(&mut pfd, 1, left.as_millis().min(250) as c_int) };
            if ready > 0 && unsafe { DNSServiceProcessResult(sd) } != 0 {
                break;
            }
        }
    }

    pub fn browse(regtype: &str, timeout: Duration) -> Vec<Service> {
        let mut found: Vec<Found> = Vec::new();
        let rt = CString::new(regtype).unwrap();
        let mut sd: Ref = std::ptr::null_mut();
        let err = unsafe { DNSServiceBrowse(&mut sd, 0, 0, rt.as_ptr(), std::ptr::null(), on_browse, &mut found as *mut _ as *mut c_void) };
        if err != 0 {
            return Vec::new();
        }
        pump(sd, Instant::now() + timeout, &|| false);
        unsafe { DNSServiceRefDeallocate(sd) };

        found
            .into_iter()
            .filter_map(|f| {
                let (name, rt, dom) = (CString::new(f.name.clone()).ok()?, CString::new(f.regtype).ok()?, CString::new(f.domain).ok()?);
                let mut result: Option<(String, u16, HashMap<String, String>)> = None;
                let mut sd: Ref = std::ptr::null_mut();
                let ptr = &mut result as *mut _ as *mut c_void;
                if unsafe { DNSServiceResolve(&mut sd, 0, f.iface, name.as_ptr(), rt.as_ptr(), dom.as_ptr(), on_resolve, ptr) } != 0 {
                    return None;
                }
                let flag = &result as *const Option<(String, u16, HashMap<String, String>)>;
                pump(sd, Instant::now() + Duration::from_secs(2), &|| unsafe { (*flag).is_some() });
                unsafe { DNSServiceRefDeallocate(sd) };
                let (host, port, txt) = result?;
                Some(Service { name: f.name, host, port, txt })
            })
            .collect()
    }
}

#[cfg(not(target_os = "macos"))]
fn discover_chromecasts(timeout: Duration) -> Vec<CastDevice> {
    let Ok(daemon) = mdns_sd::ServiceDaemon::new() else { return Vec::new() };
    let Ok(rx) = daemon.browse("_googlecast._tcp.local.") else { return Vec::new() };
    let deadline = Instant::now() + timeout;
    let mut out: Vec<CastDevice> = Vec::new();
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) => {
                let Some(addr) = info.get_addresses().iter().find(|a| a.is_ipv4()).or_else(|| info.get_addresses().iter().next()) else { continue };
                let id = info.get_property_val_str("id").unwrap_or(info.get_fullname()).to_string();
                if out.iter().any(|d| d.id == id) {
                    continue;
                }
                out.push(CastDevice {
                    id,
                    name: info.get_property_val_str("fn").unwrap_or("Chromecast").to_string(),
                    kind: "chromecast".into(),
                    host: addr.to_string(),
                    port: info.get_port(),
                    model: info.get_property_val_str("md").map(str::to_owned),
                    av_transport: None,
                    rendering: None,
                });
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    let _ = daemon.shutdown();
    out
}

fn tag<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&format!("</{name}>"))? + start;
    Some(xml[start..end].trim())
}

fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// Resolves a (possibly relative) control URL against the device description's location.
fn absolute(base: &str, path: &str) -> String {
    if path.starts_with("http://") || path.starts_with("https://") {
        return path.to_string();
    }
    let origin = base.split('/').take(3).collect::<Vec<_>>().join("/");
    if path.starts_with('/') {
        format!("{origin}{path}")
    } else {
        format!("{origin}/{path}")
    }
}

async fn dlna_describe(location: String) -> Option<CastDevice> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(4)).build().ok()?;
    let xml = client.get(&location).send().await.ok()?.text().await.ok()?;
    if !xml.contains("MediaRenderer") {
        return None;
    }
    let base = tag(&xml, "URLBase").map(str::to_owned).unwrap_or_else(|| location.clone());
    let mut av = None;
    let mut rendering = None;
    for block in xml.split("<service>").skip(1) {
        let block = block.split("</service>").next().unwrap_or_default();
        let (Some(kind), Some(control)) = (tag(block, "serviceType"), tag(block, "controlURL")) else { continue };
        if kind.contains(":AVTransport:") {
            av = Some(absolute(&base, &xml_unescape(control)));
        } else if kind.contains(":RenderingControl:") {
            rendering = Some(absolute(&base, &xml_unescape(control)));
        }
    }
    let av = av?;
    let host = location.split('/').nth(2)?.to_string();
    let (h, p) = host.rsplit_once(':').map(|(h, p)| (h.to_string(), p.parse().unwrap_or(80))).unwrap_or((host.clone(), 80));
    Some(CastDevice {
        id: tag(&xml, "UDN").map(str::to_owned).unwrap_or_else(|| location.clone()),
        name: tag(&xml, "friendlyName").map(xml_unescape).unwrap_or_else(|| "TV".into()),
        kind: "dlna".into(),
        host: h,
        port: p,
        model: tag(&xml, "modelName").map(xml_unescape),
        av_transport: Some(av),
        rendering,
    })
}

fn ssdp_locations(timeout: Duration) -> Vec<String> {
    let Ok(socket) = UdpSocket::bind("0.0.0.0:0") else { return Vec::new() };
    let _ = socket.set_read_timeout(Some(Duration::from_millis(250)));
    let search = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n";
    let deadline = Instant::now() + timeout;
    let mut last_send = Instant::now() - Duration::from_secs(5);
    let mut out = Vec::new();
    let mut buf = [0u8; 2048];
    while Instant::now() < deadline {
        if last_send.elapsed() > Duration::from_millis(900) {
            let _ = socket.send_to(search.as_bytes(), "239.255.255.250:1900");
            last_send = Instant::now();
        }
        if let Ok((n, _)) = socket.recv_from(&mut buf) {
            let text = String::from_utf8_lossy(&buf[..n]);
            if let Some(loc) = text.lines().find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case("location")).map(|(_, v)| v.trim().to_string())) {
                if !out.contains(&loc) {
                    out.push(loc);
                }
            }
        }
    }
    out
}

/// Chromecasts and DLNA TVs on the network (takes about three seconds).
#[tauri::command]
pub async fn cast_discover() -> Vec<CastDevice> {
    let (cc, locations) = tauri::async_runtime::spawn_blocking(|| {
        let cc = std::thread::spawn(|| discover_chromecasts(Duration::from_millis(2800)));
        let locations = ssdp_locations(Duration::from_millis(2800));
        (cc.join().unwrap_or_default(), locations)
    })
    .await
    .unwrap_or_default();
    let mut devices = cc;
    let described = futures_join(locations.into_iter().map(dlna_describe).collect()).await;
    for d in described.into_iter().flatten() {
        // Chromecast-capable TVs often announce both; keep one entry per name.
        if !devices.iter().any(|x| x.id == d.id || (x.name == d.name && x.host == d.host)) {
            devices.push(d);
        }
    }
    devices.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    devices
}

async fn futures_join<T: Send + 'static>(futs: Vec<impl std::future::Future<Output = T> + Send + 'static>) -> Vec<T> {
    let handles: Vec<_> = futs.into_iter().map(tauri::async_runtime::spawn).collect();
    let mut out = Vec::new();
    for h in handles {
        if let Ok(v) = h.await {
            out.push(v);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Chromecast (Cast v2: TLS + length-prefixed protobuf frames carrying JSON)
// ---------------------------------------------------------------------------

const NS_CONNECTION: &str = "urn:x-cast:com.google.cast.tp.connection";
const NS_HEARTBEAT: &str = "urn:x-cast:com.google.cast.tp.heartbeat";
const NS_RECEIVER: &str = "urn:x-cast:com.google.cast.receiver";
const NS_MEDIA: &str = "urn:x-cast:com.google.cast.media";
/// Google's Default Media Receiver.
const APP_ID: &str = "CC1AD845";

fn varint(mut v: u64, out: &mut Vec<u8>) {
    loop {
        let byte = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

/// Encodes a CastMessage (protocol_version=0, payload_type=STRING).
pub fn encode_message(source: &str, destination: &str, namespace: &str, payload: &str) -> Vec<u8> {
    let mut msg = Vec::with_capacity(payload.len() + 128);
    msg.extend_from_slice(&[0x08, 0x00]);
    for (field, value) in [(2u8, source), (3, destination), (4, namespace)] {
        msg.push((field << 3) | 2);
        varint(value.len() as u64, &mut msg);
        msg.extend_from_slice(value.as_bytes());
    }
    msg.extend_from_slice(&[0x28, 0x00]);
    msg.push((6 << 3) | 2);
    varint(payload.len() as u64, &mut msg);
    msg.extend_from_slice(payload.as_bytes());
    let mut framed = (msg.len() as u32).to_be_bytes().to_vec();
    framed.extend(msg);
    framed
}

/// Decodes a CastMessage into (source, namespace, payload).
pub fn decode_message(buf: &[u8]) -> Option<(String, String, String)> {
    let (mut i, mut source, mut namespace, mut payload) = (0, String::new(), String::new(), String::new());
    let read_varint = |i: &mut usize| -> Option<u64> {
        let (mut v, mut shift) = (0u64, 0);
        loop {
            let b = *buf.get(*i)?;
            *i += 1;
            v |= ((b & 0x7f) as u64) << shift;
            if b & 0x80 == 0 {
                return Some(v);
            }
            shift += 7;
        }
    };
    while i < buf.len() {
        let key = read_varint(&mut i)?;
        let (field, wire) = (key >> 3, key & 7);
        match wire {
            0 => {
                read_varint(&mut i)?;
            }
            2 => {
                let len = read_varint(&mut i)? as usize;
                let bytes = buf.get(i..i + len)?;
                i += len;
                let text = String::from_utf8_lossy(bytes).into_owned();
                match field {
                    2 => source = text,
                    4 => namespace = text,
                    6 => payload = text,
                    _ => {}
                }
            }
            _ => return None,
        }
    }
    Some((source, namespace, payload))
}

struct CastConn {
    tls: native_tls::TlsStream<TcpStream>,
    pending: Vec<u8>,
}

impl CastConn {
    fn open(host: &str, port: u16) -> Result<Self, String> {
        let addr = (host, port).to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("No address")?;
        let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(|e| format!("Couldn’t reach the Chromecast: {e}"))?;
        tcp.set_read_timeout(Some(Duration::from_millis(200))).ok();
        // Chromecasts use self-signed certificates.
        let connector = native_tls::TlsConnector::builder()
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true)
            .build()
            .map_err(|e| e.to_string())?;
        let tls = connector.connect(host, tcp).map_err(|e| format!("Chromecast connection failed: {e}"))?;
        Ok(CastConn { tls, pending: Vec::new() })
    }

    fn send(&mut self, destination: &str, namespace: &str, payload: Value) -> Result<(), String> {
        self.tls.write_all(&encode_message("sender-0", destination, namespace, &payload.to_string())).map_err(|e| e.to_string())
    }

    /// Next complete message, or None if nothing arrived within the read timeout.
    fn recv(&mut self) -> Result<Option<(String, String, Value)>, String> {
        loop {
            if self.pending.len() >= 4 {
                let len = u32::from_be_bytes(self.pending[..4].try_into().unwrap()) as usize;
                if self.pending.len() >= 4 + len {
                    let frame: Vec<u8> = self.pending.drain(..4 + len).skip(4).collect();
                    let (source, ns, payload) = decode_message(&frame).ok_or("Bad message from the Chromecast")?;
                    return Ok(Some((source, ns, serde_json::from_str(&payload).unwrap_or(Value::Null))));
                }
            }
            let mut buf = [0u8; 8192];
            match self.tls.read(&mut buf) {
                Ok(0) => return Err("The Chromecast closed the connection".into()),
                Ok(n) => self.pending.extend_from_slice(&buf[..n]),
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => return Ok(None),
                Err(e) => return Err(e.to_string()),
            }
        }
    }
}

fn chromecast_session(app: Reporter, device: CastDevice, media: CastMedia, rx: mpsc::Receiver<Command>) {
    let fail = |app: &Reporter, m: String| emit(app, "error", 0.0, 0.0, Some(m));
    let mut conn = match CastConn::open(&device.host, device.port) {
        Ok(c) => c,
        Err(e) => return fail(&app, e),
    };
    let mut request = 1u64;
    let mut next_id = || {
        request += 1;
        request
    };
    let _ = conn.send("receiver-0", NS_CONNECTION, json!({ "type": "CONNECT" }));
    let _ = conn.send("receiver-0", NS_RECEIVER, json!({ "type": "LAUNCH", "appId": APP_ID, "requestId": next_id() }));

    // Wait for the receiver app to start and give us its transport id.
    let started = Instant::now();
    let (transport, session_id) = loop {
        if started.elapsed() > Duration::from_secs(20) {
            return fail(&app, "The Chromecast didn’t start the player".into());
        }
        match conn.recv() {
            Ok(Some((_, ns, msg))) => {
                if ns == NS_HEARTBEAT && msg["type"] == "PING" {
                    let _ = conn.send("receiver-0", NS_HEARTBEAT, json!({ "type": "PONG" }));
                }
                if msg["type"] == "RECEIVER_STATUS" {
                    if let Some(a) = msg["status"]["applications"].as_array().and_then(|apps| apps.iter().find(|a| a["appId"] == APP_ID)) {
                        if let (Some(t), Some(s)) = (a["transportId"].as_str(), a["sessionId"].as_str()) {
                            break (t.to_string(), s.to_string());
                        }
                    }
                }
                if msg["type"] == "LAUNCH_ERROR" {
                    return fail(&app, "The Chromecast refused to start the player".into());
                }
            }
            Ok(None) => {}
            Err(e) => return fail(&app, e),
        }
    };
    let _ = conn.send(&transport, NS_CONNECTION, json!({ "type": "CONNECT" }));
    let hls = media.content_type.contains("mpegurl");
    let mut media_info = json!({
        "contentId": media.url,
        "contentUrl": media.url,
        "streamType": "BUFFERED",
        "contentType": media.content_type,
        "metadata": {
            "metadataType": 0,
            "title": media.title,
            "subtitle": media.subtitle,
            "images": media.image.as_ref().map(|u| vec![json!({ "url": u })]).unwrap_or_default(),
        },
    });
    if hls {
        media_info["hlsSegmentFormat"] = json!("ts");
        media_info["hlsVideoSegmentFormat"] = json!("mpeg2_ts");
    }
    if media.duration > 0.0 {
        media_info["duration"] = json!(media.duration);
    }
    let _ = conn.send(&transport, NS_MEDIA, json!({ "type": "LOAD", "requestId": next_id(), "media": media_info, "autoplay": true, "currentTime": media.start }));
    emit(&app, "buffering", media.start, media.duration, None);

    let mut media_session: Option<i64> = None;
    let (mut last_poll, mut last_ping) = (Instant::now(), Instant::now());
    let mut last_time = media.start;
    loop {
        // Commands from the app.
        match rx.try_recv() {
            Ok(cmd) => {
                let id = next_id();
                let sent = match (cmd, media_session) {
                    (Command::Play, Some(m)) => conn.send(&transport, NS_MEDIA, json!({ "type": "PLAY", "mediaSessionId": m, "requestId": id })),
                    (Command::Pause, Some(m)) => conn.send(&transport, NS_MEDIA, json!({ "type": "PAUSE", "mediaSessionId": m, "requestId": id })),
                    (Command::Seek(t), Some(m)) => conn.send(&transport, NS_MEDIA, json!({ "type": "SEEK", "mediaSessionId": m, "requestId": id, "currentTime": t })),
                    (Command::Volume(v), _) => conn.send("receiver-0", NS_RECEIVER, json!({ "type": "SET_VOLUME", "requestId": id, "volume": { "level": v.clamp(0.0, 1.0) } })),
                    (Command::Stop, _) => {
                        let _ = conn.send("receiver-0", NS_RECEIVER, json!({ "type": "STOP", "sessionId": session_id, "requestId": id }));
                        emit(&app, "idle", last_time, media.duration, None);
                        return;
                    }
                    _ => Ok(()),
                };
                if let Err(e) = sent {
                    return fail(&app, e);
                }
            }
            Err(mpsc::TryRecvError::Disconnected) => return,
            Err(mpsc::TryRecvError::Empty) => {}
        }
        if last_ping.elapsed() > Duration::from_secs(5) {
            let _ = conn.send("receiver-0", NS_HEARTBEAT, json!({ "type": "PING" }));
            last_ping = Instant::now();
        }
        if last_poll.elapsed() > Duration::from_secs(1) {
            let _ = conn.send(&transport, NS_MEDIA, json!({ "type": "GET_STATUS", "requestId": next_id() }));
            last_poll = Instant::now();
        }
        match conn.recv() {
            Ok(Some((_, ns, msg))) => {
                if ns == NS_HEARTBEAT && msg["type"] == "PING" {
                    let _ = conn.send("receiver-0", NS_HEARTBEAT, json!({ "type": "PONG" }));
                }
                match msg["type"].as_str() {
                    Some("MEDIA_STATUS") => {
                        if let Some(st) = msg["status"].as_array().and_then(|s| s.first()) {
                            media_session = st["mediaSessionId"].as_i64().or(media_session);
                            last_time = st["currentTime"].as_f64().unwrap_or(last_time);
                            let duration = st["media"]["duration"].as_f64().filter(|d| *d > 0.0).unwrap_or(media.duration);
                            let state = match st["playerState"].as_str() {
                                Some("PLAYING") => "playing",
                                Some("PAUSED") => "paused",
                                Some("BUFFERING") | Some("LOADING") => "buffering",
                                Some("IDLE") if st["idleReason"] == "FINISHED" => "ended",
                                Some("IDLE") if st["idleReason"] == "ERROR" => "error",
                                _ => "idle",
                            };
                            let message = (state == "error").then(|| "The Chromecast couldn’t play this video".to_string());
                            emit(&app, state, last_time, duration, message);
                            if state == "ended" || state == "error" {
                                return;
                            }
                        }
                    }
                    Some("LOAD_FAILED") | Some("LOAD_CANCELLED") => return fail(&app, "The Chromecast couldn’t load this video".into()),
                    Some("CLOSE") => {
                        emit(&app, "idle", last_time, media.duration, Some("Casting ended on the TV".into()));
                        return;
                    }
                    _ => {}
                }
            }
            Ok(None) => {}
            Err(e) => return fail(&app, e),
        }
    }
}

// ---------------------------------------------------------------------------
// DLNA / UPnP AVTransport
// ---------------------------------------------------------------------------

async fn soap(url: &str, service: &str, action: &str, args: &str) -> Result<String, String> {
    let body = format!(
        r#"<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:{action} xmlns:u="urn:schemas-upnp-org:service:{service}:1">{args}</u:{action}></s:Body></s:Envelope>"#
    );
    let client = reqwest::Client::builder().timeout(Duration::from_secs(8)).build().map_err(|e| e.to_string())?;
    let res = client
        .post(url)
        .header("Content-Type", r#"text/xml; charset="utf-8""#)
        .header("SOAPAction", format!(r#""urn:schemas-upnp-org:service:{service}:1#{action}""#))
        .body(body)
        .send()
        .await
        .map_err(|e| format!("The TV didn’t respond: {e}"))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        let reason = tag(&text, "errorDescription").map(str::to_owned).unwrap_or_else(|| status.to_string());
        return Err(format!("The TV refused {action}: {reason}"));
    }
    Ok(text)
}

fn hms(t: f64) -> String {
    let s = t.max(0.0) as u64;
    format!("{}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60)
}

fn parse_hms(s: &str) -> f64 {
    let parts: Vec<f64> = s.split(':').map(|p| p.parse().unwrap_or(0.0)).collect();
    match parts.as_slice() {
        [h, m, sec] => h * 3600.0 + m * 60.0 + sec,
        [m, sec] => m * 60.0 + sec,
        _ => 0.0,
    }
}

async fn dlna_session(app: Reporter, device: CastDevice, media: CastMedia, rx: mpsc::Receiver<Command>) {
    let Some(av) = device.av_transport.clone() else { return emit(&app, "error", 0.0, 0.0, Some("This TV can’t be controlled".into())) };
    let didl = format!(
        r#"<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>{}</dc:title><upnp:class>object.item.videoItem.movie</upnp:class><res protocolInfo="http-get:*:{}:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000">{}</res></item></DIDL-Lite>"#,
        xml_escape(&media.title),
        media.content_type,
        xml_escape(&media.url)
    );
    let set = format!("<InstanceID>0</InstanceID><CurrentURI>{}</CurrentURI><CurrentURIMetaData>{}</CurrentURIMetaData>", xml_escape(&media.url), xml_escape(&didl));
    let _ = soap(&av, "AVTransport", "Stop", "<InstanceID>0</InstanceID>").await;
    if let Err(e) = soap(&av, "AVTransport", "SetAVTransportURI", &set).await {
        return emit(&app, "error", 0.0, 0.0, Some(e));
    }
    if let Err(e) = soap(&av, "AVTransport", "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>").await {
        return emit(&app, "error", 0.0, 0.0, Some(e));
    }
    emit(&app, "buffering", media.start, media.duration, None);

    let started = Instant::now();
    let (mut played, mut sought, mut last_time) = (false, media.start <= 1.0, media.start);
    loop {
        // Commands.
        while let Ok(cmd) = rx.try_recv() {
            let res = match cmd {
                Command::Play => soap(&av, "AVTransport", "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>").await,
                Command::Pause => soap(&av, "AVTransport", "Pause", "<InstanceID>0</InstanceID>").await,
                Command::Seek(t) => soap(&av, "AVTransport", "Seek", &format!("<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>{}</Target>", hms(t))).await,
                Command::Volume(v) => match &device.rendering {
                    Some(r) => soap(r, "RenderingControl", "SetVolume", &format!("<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>{}</DesiredVolume>", (v.clamp(0.0, 1.0) * 100.0).round())).await,
                    None => Ok(String::new()),
                },
                Command::Stop => {
                    let _ = soap(&av, "AVTransport", "Stop", "<InstanceID>0</InstanceID>").await;
                    emit(&app, "idle", last_time, media.duration, None);
                    return;
                }
            };
            if let Err(e) = res {
                emit(&app, if played { "paused" } else { "buffering" }, last_time, media.duration, Some(e));
            }
        }
        if matches!(rx.try_recv(), Err(mpsc::TryRecvError::Disconnected)) {
            return;
        }
        // Status.
        let transport = soap(&av, "AVTransport", "GetTransportInfo", "<InstanceID>0</InstanceID>").await.ok();
        let position = soap(&av, "AVTransport", "GetPositionInfo", "<InstanceID>0</InstanceID>").await.ok();
        let state = transport.as_deref().and_then(|x| tag(x, "CurrentTransportState")).unwrap_or("").to_string();
        if let Some(p) = position.as_deref() {
            last_time = tag(p, "RelTime").map(parse_hms).unwrap_or(last_time);
        }
        let duration = position.as_deref().and_then(|p| tag(p, "TrackDuration")).map(parse_hms).filter(|d| *d > 0.0).unwrap_or(media.duration);
        match state.as_str() {
            "PLAYING" => {
                played = true;
                if !sought {
                    sought = true;
                    let _ = soap(&av, "AVTransport", "Seek", &format!("<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>{}</Target>", hms(media.start))).await;
                }
                emit(&app, "playing", last_time, duration, None);
            }
            "PAUSED_PLAYBACK" => emit(&app, "paused", last_time, duration, None),
            "TRANSITIONING" => emit(&app, "buffering", last_time, duration, None),
            "STOPPED" | "NO_MEDIA_PRESENT" if played => {
                let ended = duration > 0.0 && last_time >= duration - 30.0;
                emit(&app, if ended { "ended" } else { "idle" }, last_time, duration, (!ended).then(|| "Playback stopped on the TV".to_string()));
                return;
            }
            _ => {
                if !played && started.elapsed() > Duration::from_secs(15) {
                    return emit(&app, "error", 0.0, duration, Some("The TV didn’t start playing this file".into()));
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Starts casting `media` to `device` (replacing any current cast).
#[tauri::command]
pub fn cast_start(app: AppHandle, device: CastDevice, media: CastMedia) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    if let Some(old) = SESSION.lock().unwrap().replace(tx) {
        let _ = old.send(Command::Stop);
    }
    let app = reporter(app);
    emit(&app, "connecting", media.start, media.duration, None);
    if device.kind == "chromecast" {
        std::thread::spawn(move || chromecast_session(app, device, media, rx));
    } else {
        tauri::async_runtime::spawn(dlna_session(app, device, media, rx));
    }
    Ok(())
}

#[tauri::command]
pub fn cast_control(action: String, value: Option<f64>) -> Result<(), String> {
    let cmd = match action.as_str() {
        "play" => Command::Play,
        "pause" => Command::Pause,
        "seek" => Command::Seek(value.unwrap_or(0.0)),
        "volume" => Command::Volume(value.unwrap_or(0.5)),
        "stop" => Command::Stop,
        other => return Err(format!("Unknown action {other}")),
    };
    let guard = SESSION.lock().unwrap();
    let tx = guard.as_ref().ok_or("Not casting")?;
    tx.send(cmd).map_err(|_| "Casting has ended".to_string())?;
    if action == "stop" {
        drop(guard);
        *SESSION.lock().unwrap() = None;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cast_messages_round_trip() {
        let payload = json!({ "type": "LOAD", "media": { "contentId": "http://x/é" } }).to_string();
        let framed = encode_message("sender-0", "receiver-0", NS_MEDIA, &payload);
        let len = u32::from_be_bytes(framed[..4].try_into().unwrap()) as usize;
        assert_eq!(len, framed.len() - 4);
        let (source, ns, body) = decode_message(&framed[4..]).unwrap();
        assert_eq!((source.as_str(), ns.as_str(), body.as_str()), ("sender-0", NS_MEDIA, payload.as_str()));
        // Long payloads need multi-byte varints.
        let big = "x".repeat(1000);
        let framed = encode_message("a", "b", "c", &big);
        assert_eq!(decode_message(&framed[4..]).unwrap().2, big);
    }

    /// A fake DLNA TV: serves a device description and answers AVTransport SOAP calls.
    fn fake_tv() -> (String, std::sync::Arc<Mutex<Vec<String>>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let actions = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
        let log = actions.clone();
        std::thread::spawn(move || {
            let started = Instant::now();
            let mut playing_since: Option<Instant> = None;
            for conn in listener.incoming().flatten() {
                let mut conn = conn;
                let mut buf = vec![0u8; 16384];
                let n = conn.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).into_owned();
                let body = if req.starts_with("GET /desc.xml") {
                    "<?xml version=\"1.0\"?><root><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>Fake TV</friendlyName><modelName>Test</modelName><UDN>uuid:fake</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/avt</controlURL></service></serviceList></device></root>".to_string()
                } else {
                    let action = req.split("#").nth(1).and_then(|a| a.split('"').next()).unwrap_or("").to_string();
                    log.lock().unwrap().push(action.clone());
                    if action == "Play" {
                        playing_since.get_or_insert(Instant::now());
                    }
                    let state = if playing_since.is_some() { "PLAYING" } else { "STOPPED" };
                    let rel = playing_since.map(|t| t.elapsed().as_secs() + 600).unwrap_or(0);
                    let _ = started;
                    format!("<s:Envelope><s:Body><u:{action}Response><CurrentTransportState>{state}</CurrentTransportState><RelTime>0:{:02}:{:02}</RelTime><TrackDuration>0:20:00</TrackDuration></u:{action}Response></s:Body></s:Envelope>", rel / 60, rel % 60)
                };
                let _ = conn.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes());
            }
        });
        (format!("http://127.0.0.1:{port}/desc.xml"), actions)
    }

    #[test]
    fn controls_a_dlna_tv() {
        let (location, actions) = fake_tv();
        let device = tauri::async_runtime::block_on(dlna_describe(location)).expect("description");
        assert_eq!((device.name.as_str(), device.kind.as_str()), ("Fake TV", "dlna"));
        assert!(device.av_transport.as_deref().unwrap().ends_with("/avt"));

        let events = std::sync::Arc::new(Mutex::new(Vec::<(String, f64)>::new()));
        let rec = events.clone();
        let report: Reporter = std::sync::Arc::new(move |state, time, _d, _m| rec.lock().unwrap().push((state.to_string(), time)));
        let (tx, rx) = mpsc::channel();
        let media = CastMedia { url: "http://10.0.0.2:8000/stream/abc/file".into(), content_type: "video/x-matroska".into(), title: "Dune & Co".into(), subtitle: None, image: None, start: 600.0, duration: 1200.0 };
        let handle = std::thread::spawn(move || tauri::async_runtime::block_on(dlna_session(report, device, media, rx)));
        std::thread::sleep(Duration::from_millis(2500));
        tx.send(Command::Pause).unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        tx.send(Command::Stop).unwrap();
        handle.join().unwrap();
        let log = actions.lock().unwrap().clone();
        for expected in ["SetAVTransportURI", "Play", "GetTransportInfo", "GetPositionInfo", "Seek", "Pause", "Stop"] {
            assert!(log.iter().any(|a| a == expected), "missing {expected} in {log:?}");
        }
        let ev = events.lock().unwrap().clone();
        assert!(ev.iter().any(|(s, t)| s == "playing" && *t >= 600.0), "{ev:?}");
        assert_eq!(ev.last().unwrap().0, "idle");
    }

    /// A fake Chromecast over TLS (needs the `openssl` CLI for a throwaway certificate).
    #[test]
    #[ignore]
    fn controls_a_fake_chromecast() {
        let dir = std::env::temp_dir().join("truongflix-fake-cc");
        std::fs::create_dir_all(&dir).unwrap();
        let ok = std::process::Command::new("openssl")
            .args(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=fake"])
            .arg("-keyout").arg(dir.join("key.pem")).arg("-out").arg(dir.join("cert.pem"))
            .output().map(|o| o.status.success()).unwrap_or(false);
        assert!(ok, "openssl failed");
        let identity = native_tls::Identity::from_pkcs8(&std::fs::read(dir.join("cert.pem")).unwrap(), &std::fs::read(dir.join("key.pem")).unwrap()).unwrap();
        let acceptor = native_tls::TlsAcceptor::new(identity).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            let (tcp, _) = listener.accept().unwrap();
            let mut tls = acceptor.accept(tcp).unwrap();
            let mut pending = Vec::new();
            let mut time = 0.0;
            let mut state = "BUFFERING";
            loop {
                let mut buf = [0u8; 4096];
                let n = match tls.read(&mut buf) { Ok(0) | Err(_) => return, Ok(n) => n };
                pending.extend_from_slice(&buf[..n]);
                while pending.len() >= 4 {
                    let len = u32::from_be_bytes(pending[..4].try_into().unwrap()) as usize;
                    if pending.len() < 4 + len { break; }
                    let frame: Vec<u8> = pending.drain(..4 + len).skip(4).collect();
                    let (_, ns, payload) = decode_message(&frame).unwrap();
                    let msg: Value = serde_json::from_str(&payload).unwrap();
                    let kind = msg["type"].as_str().unwrap_or("").to_string();
                    log.lock().unwrap().push(kind.clone());
                    let reply = |tls: &mut native_tls::TlsStream<std::net::TcpStream>, src: &str, ns: &str, v: Value| {
                        tls.write_all(&encode_message(src, "sender-0", ns, &v.to_string())).unwrap();
                    };
                    match kind.as_str() {
                        "LAUNCH" => reply(&mut tls, "receiver-0", NS_RECEIVER, json!({ "type": "RECEIVER_STATUS", "status": { "applications": [{ "appId": APP_ID, "transportId": "web-5", "sessionId": "s-1" }] } })),
                        "LOAD" => {
                            time = msg["currentTime"].as_f64().unwrap_or(0.0);
                            state = "PLAYING";
                        }
                        "PAUSE" => state = "PAUSED",
                        "SEEK" => time = msg["currentTime"].as_f64().unwrap_or(time),
                        "GET_STATUS" => {
                            if state == "PLAYING" { time += 1.0; }
                            reply(&mut tls, "web-5", NS_MEDIA, json!({ "type": "MEDIA_STATUS", "status": [{ "mediaSessionId": 7, "playerState": state, "currentTime": time, "media": { "duration": 1200.0 } }] }));
                        }
                        "PING" => reply(&mut tls, "receiver-0", &ns, json!({ "type": "PONG" })),
                        _ => {}
                    }
                }
            }
        });
        let events = std::sync::Arc::new(Mutex::new(Vec::<(String, f64)>::new()));
        let rec = events.clone();
        let report: Reporter = std::sync::Arc::new(move |state, time, _d, _m| rec.lock().unwrap().push((state.to_string(), time)));
        let device = CastDevice { id: "cc".into(), name: "Fake CC".into(), kind: "chromecast".into(), host: "127.0.0.1".into(), port, model: None, av_transport: None, rendering: None };
        let media = CastMedia { url: "http://10.0.0.2:8000/stream/abc/j/index.m3u8".into(), content_type: "application/x-mpegurl".into(), title: "Test".into(), subtitle: None, image: None, start: 300.0, duration: 1200.0 };
        let (tx, rx) = mpsc::channel();
        let handle = std::thread::spawn(move || chromecast_session(report, device, media, rx));
        std::thread::sleep(Duration::from_millis(2500));
        tx.send(Command::Seek(900.0)).unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        tx.send(Command::Pause).unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        tx.send(Command::Stop).unwrap();
        handle.join().unwrap();
        let log = seen.lock().unwrap().clone();
        for expected in ["CONNECT", "LAUNCH", "LOAD", "GET_STATUS", "SEEK", "PAUSE", "STOP"] {
            assert!(log.iter().any(|a| a == expected), "missing {expected} in {log:?}");
        }
        let ev = events.lock().unwrap().clone();
        assert!(ev.iter().any(|(s, t)| s == "playing" && *t >= 300.0), "{ev:?}");
        assert!(ev.iter().any(|(s, t)| s == "playing" && *t >= 900.0), "seek not reflected: {ev:?}");
        assert!(ev.iter().any(|(s, _)| s == "paused"), "{ev:?}");
        println!("events: {ev:?}");
    }

    /// Announces a fake Chromecast over mDNS and finds it again.
    #[cfg(not(target_os = "macos"))]
    #[test]
    #[ignore]
    fn discovers_an_announced_chromecast() {
        let daemon = mdns_sd::ServiceDaemon::new().unwrap();
        let host_ip = crate::stream::local_ip_for("192.168.0.1").map(|i| i.to_string()).unwrap_or_else(|| "127.0.0.1".into());
        let props = [("id", "fake-cc-123"), ("fn", "Test Living Room"), ("md", "Chromecast Ultra")];
        let info = mdns_sd::ServiceInfo::new("_googlecast._tcp.local.", "Chromecast-fake", "fake-cc.local.", host_ip.as_str(), 8009, &props[..]).unwrap();
        daemon.register(info).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let found = discover_chromecasts(Duration::from_secs(3));
        let _ = daemon.shutdown();
        println!("found: {found:?}");
        assert!(found.iter().any(|d| d.name == "Test Living Room" && d.port == 8009 && d.model.as_deref() == Some("Chromecast Ultra")));
    }

    /// macOS: a device announced with `dns-sd -R` is found.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn discovers_a_bonjour_chromecast() {
        let mut child = std::process::Command::new("dns-sd")
            .args(["-R", "Chromecast-test", "_googlecast._tcp", "local", "8009", "id=t1", "fn=Bonjour Test TV", "md=Chromecast Ultra"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(700));
        let found = discover_chromecasts(Duration::from_secs(3));
        let _ = child.kill();
        let _ = child.wait();
        println!("found: {found:?}");
        assert!(found.iter().any(|d| d.name == "Bonjour Test TV" && d.port == 8009 && d.model.as_deref() == Some("Chromecast Ultra") && !d.host.is_empty()));
    }

    /// Lists what's on the network: `cargo test -- --ignored real_discovery --nocapture`
    #[test]
    #[ignore]
    fn real_discovery() {
        let t = Instant::now();
        let devices = tauri::async_runtime::block_on(cast_discover());
        println!("{} device(s) in {:?}", devices.len(), t.elapsed());
        for d in devices {
            println!("  {} · {} · {}:{} · {:?}", d.kind, d.name, d.host, d.port, d.model);
        }
    }

    #[test]
    fn parses_dlna_bits() {
        assert_eq!(parse_hms("1:02:03"), 3723.0);
        assert_eq!(parse_hms("0:00:07.500"), 7.5);
        assert_eq!(hms(3723.9), "1:02:03");
        assert_eq!(absolute("http://10.0.0.5:1400/xml/desc.xml", "/MediaRenderer/AVTransport/Control"), "http://10.0.0.5:1400/MediaRenderer/AVTransport/Control");
        assert_eq!(absolute("http://10.0.0.5:1400/xml/desc.xml", "AVT/ctrl"), "http://10.0.0.5:1400/AVT/ctrl");
        let xml = "<root><device><friendlyName>Living Room &amp; TV</friendlyName><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/avt</controlURL></service></serviceList></device></root>";
        assert_eq!(tag(xml, "friendlyName").map(xml_unescape).as_deref(), Some("Living Room & TV"));
    }
}
