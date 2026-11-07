//! Reads the games library and settings from the app database, so commands act on the folders
//! recorded there rather than on paths the page hands over.

use std::time::Duration;

use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection, SqliteConnection};
use tauri::{AppHandle, Manager};

pub struct GameRecord {
    pub installer_dir: Option<String>,
    pub install_dir: Option<String>,
    pub exe_path: Option<String>,
    pub info_hash: Option<String>,
}

async fn connect(app: &AppHandle) -> Result<SqliteConnection, String> {
    // The SQL plugin keeps sqlite:truongflix.db in the app config folder.
    let path = app.path().app_config_dir().map_err(|e| e.to_string())?.join("truongflix.db");
    SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .busy_timeout(Duration::from_secs(5))
        .pragma("trusted_schema", "OFF")
        .connect()
        .await
        .map_err(|e| format!("Couldn't read the library: {e}"))
}

fn text(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

pub async fn game(app: &AppHandle, id: i64) -> Result<GameRecord, String> {
    let mut db = connect(app).await?;
    let row: Option<(Option<String>, Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT installer_dir, install_dir, exe_path, info_hash FROM games_library WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut db)
            .await
            .map_err(|e| e.to_string())?;
    let _ = db.close().await;
    let (installer_dir, install_dir, exe_path, info_hash) = row.ok_or("This game is no longer in the library.")?;
    Ok(GameRecord {
        installer_dir: text(installer_dir),
        install_dir: text(install_dir),
        exe_path: text(exe_path),
        info_hash: text(info_hash),
    })
}

pub async fn setting(app: &AppHandle, key: &str) -> Result<Option<String>, String> {
    let mut db = connect(app).await?;
    let value: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(&mut db)
        .await
        .map_err(|e| e.to_string())?;
    let _ = db.close().await;
    Ok(text(value))
}

/// Where a torrent was saved, when it is still recorded.
pub async fn torrent_save_path(app: &AppHandle, info_hash: &str) -> Result<Option<String>, String> {
    let mut db = connect(app).await?;
    let value: Option<String> = sqlx::query_scalar("SELECT save_path FROM torrents WHERE lower(info_hash) = ?")
        .bind(info_hash.to_ascii_lowercase())
        .fetch_optional(&mut db)
        .await
        .map_err(|e| e.to_string())?;
    let _ = db.close().await;
    Ok(text(value))
}
