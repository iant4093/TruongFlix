//! A loopback HTTP origin for YouTube embeds. WKWebView's tauri:// origin cannot send
//! an HTTP Referer, which YouTube requires (error 153). No library data is served here.

use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::OnceCell,
};

static PORT: OnceCell<u16> = OnceCell::const_new();
const PAGE: &str = include_str!("trailer.html");

fn valid_key(key: &str) -> bool {
    key.len() == 11
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

async fn serve(mut conn: TcpStream) -> std::io::Result<()> {
    let mut request = Vec::new();
    let mut buf = [0; 1024];
    loop {
        let n = match tokio::time::timeout(Duration::from_secs(5), conn.read(&mut buf)).await {
            Ok(Ok(n)) if n > 0 => n,
            _ => return Ok(()),
        };
        request.extend_from_slice(&buf[..n]);
        if request.len() > 8192 {
            return Ok(());
        }
        if request.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let text = String::from_utf8_lossy(&request);
    let mut first = text.lines().next().unwrap_or_default().split_whitespace();
    let method = first.next().unwrap_or_default();
    let key = first
        .next()
        .unwrap_or_default()
        .strip_prefix("/embed/")
        .unwrap_or_default();
    let (status, body) = if method != "GET" && method != "HEAD" {
        ("405 Method Not Allowed", String::new())
    } else if !valid_key(key) {
        ("404 Not Found", String::new())
    } else {
        ("200 OK", PAGE.replace("__VIDEO_KEY__", key))
    };
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: strict-origin-when-cross-origin\r\nContent-Security-Policy: default-src 'none'; script-src 'unsafe-inline' https://www.youtube.com https://s.ytimg.com; style-src 'unsafe-inline'; frame-src https://www.youtube-nocookie.com\r\nConnection: close\r\n\r\n", body.len()
    );
    conn.write_all(header.as_bytes()).await?;
    if method != "HEAD" {
        conn.write_all(body.as_bytes()).await?;
    }
    conn.flush().await
}

async fn start_server() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    tokio::spawn(async move {
        while let Ok((conn, _)) = listener.accept().await {
            tokio::spawn(async move {
                let _ = serve(conn).await;
            });
        }
    });
    Ok(port)
}

#[tauri::command]
pub async fn trailer_embed_url(key: String) -> Result<String, String> {
    if !valid_key(&key) {
        return Err("Invalid YouTube video ID".into());
    }
    let port = PORT.get_or_try_init(start_server).await?;
    Ok(format!("http://127.0.0.1:{port}/embed/{key}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn embed_server_validates_keys_and_serves_only_the_wrapper() {
        assert!(trailer_embed_url("../settings".into()).await.is_err());
        let url = trailer_embed_url("vKQi3bBA1y8".into()).await.unwrap();
        assert!(url.starts_with("http://127.0.0.1:"));
        let client = reqwest::Client::new();
        let response = client.get(&url).send().await.unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.headers()["referrer-policy"],
            "strict-origin-when-cross-origin"
        );
        let page = response.text().await.unwrap();
        assert!(page.contains("videoId: 'vKQi3bBA1y8'"));
        assert!(page.contains("captionSafe"));
        assert!(!page.contains("__VIDEO_KEY__"));
        let base = url.split("/embed/").next().unwrap();
        for path in [
            "/",
            "/api/library",
            "/embed/invalid",
            "/embed/abcdefghijk/more",
        ] {
            assert_eq!(
                client
                    .get(format!("{base}{path}"))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                404
            );
        }
        assert_eq!(client.post(&url).send().await.unwrap().status(), 405);
    }
}
