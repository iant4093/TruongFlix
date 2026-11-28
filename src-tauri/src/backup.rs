//! Portable SQLite snapshots. Restore runs before the application's connection pool opens.
//!
//! What a backup carries is listed in `src/services/backupManifest.json` (shared with the UI and
//! its tests): every setting key by kind, every table, and the few browser-storage preferences.
//!
//! Format versions (`PRAGMA user_version` of the backup file):
//! - 1: the database tables, secrets left out.
//! - 2: adds `backup_meta` (whether passwords and keys are inside), `backup_local` (preferences kept
//!   in the window's storage) and `backup_files` (playlist covers). Version 1 backups still restore.
use libsqlite3_sys::{
    sqlite3, sqlite3_api_routines, sqlite3_auto_extension, sqlite3_backup_finish, sqlite3_backup_init,
    sqlite3_backup_step, sqlite3_set_authorizer, SQLITE_ATTACH, SQLITE_DENY, SQLITE_DETACH, SQLITE_DONE,
    SQLITE_FUNCTION, SQLITE_OK,
};
use std::ffi::{c_char, c_int, c_void, CStr};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions, Connection, Row, SqliteConnection};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tempfile::NamedTempFile;

const DB: &str = "truongflix.db";
const PENDING: &str = "restore-pending.db";
const RECOVERY: &str = "Before restore.truongflix-backup";
const APPLICATION_ID: i64 = 0x5452_4658; // TRFX
/// The format this version writes.
const VERSION: i64 = 2;
/// The oldest format this version restores.
const OLDEST: i64 = 1;
const MAX_BYTES: u64 = 512 * 1024 * 1024;
/// Largest picture or stored preference a backup carries.
const MAX_ITEM_BYTES: u64 = 20 * 1024 * 1024;
const ART_FOLDER: &str = "music-art";

/// Pictures in the music-art folder that can't be made again from the songs: a playlist's own
/// cover and the artwork of the playlist it was imported from. The columns may not exist yet.
const ART_COLUMNS: &[(&str, &str)] = &[("music_playlists", "cover"), ("music_playlists", "import_cover")];

/// Columns holding paths to files or folders, relinked with the media folders.
const PATH_COLUMNS: &[(&str, &str)] = &[
    ("movies", "file_path"),
    ("episodes", "file_path"),
    ("tv_series", "folder_path"),
    ("subtitles", "file_path"),
    ("music_tracks", "file_path"),
    ("games_library", "installer_dir"),
    ("games_library", "install_dir"),
    ("games_library", "exe_path"),
];

#[derive(Deserialize)]
struct Manifest {
    settings: SettingKinds,
    tables: TableKinds,
    #[serde(rename = "localStorage")]
    local_storage: LocalKinds,
}

/// Every setting key, by how a backup treats it.
#[derive(Deserialize)]
struct SettingKinds {
    /// Carried as is.
    plain: Vec<String>,
    /// A file path: carried, relinked with the folders around it.
    file: Vec<String>,
    /// A JSON list of folders: carried, relinked, and checked on the new computer.
    folders: Vec<String>,
    /// One folder ('' = none): carried, relinked and checked.
    folder: Vec<String>,
    /// Network shares keyed by media folder.
    shares: Vec<String>,
    /// Kept in the keychain: only in a backup the user asked to include them in.
    secret: Vec<String>,
    /// Belongs with an account among the secrets: travels with them, else this computer's stays.
    account: Vec<String>,
}

#[derive(Deserialize)]
struct TableKinds {
    /// A backup without one of these is refused.
    required: Vec<String>,
    /// Tables a backup may not have (made before the feature existed) or this computer may not have
    /// yet (Music never opened): skipped instead of refusing the restore.
    optional: Vec<String>,
    /// File-operation history and transfer sessions stay with their installation.
    local: Vec<String>,
}

#[derive(Deserialize)]
struct LocalKinds {
    carry: Vec<String>,
}

fn manifest() -> &'static Manifest {
    static MANIFEST: OnceLock<Manifest> = OnceLock::new();
    MANIFEST.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/services/backupManifest.json")).expect("the backup manifest is valid")
    })
}

/// Tables a restore replaces, in order.
fn portable_tables() -> Vec<&'static str> {
    let tables = &manifest().tables;
    tables.required.iter().chain(&tables.optional).map(String::as_str).collect()
}

fn is_optional(table: &str) -> bool {
    manifest().tables.optional.iter().any(|t| t == table)
}

/// Folder settings checked on the new computer and offered for relinking.
fn folder_keys() -> impl Iterator<Item = &'static str> {
    let s = &manifest().settings;
    s.folders.iter().chain(&s.folder).map(String::as_str)
}

/// Secret settings, and the settings that belong with them.
fn carried_with_secrets() -> Vec<&'static str> {
    let s = &manifest().settings;
    s.secret.iter().chain(&s.account).map(String::as_str).collect()
}

fn sql_list<S: AsRef<str>>(keys: &[S]) -> String {
    if keys.is_empty() {
        return "NULL".into(); // `IN (NULL)` matches nothing
    }
    keys.iter().map(|k| format!("'{}'", k.as_ref().replace('\'', "''"))).collect::<Vec<_>>().join(", ")
}

fn secret_list() -> String {
    sql_list(crate::secrets::KEYS)
}

#[derive(Default)]
pub struct BackupState {
    operation: tokio::sync::Mutex<()>,
    result: Mutex<Option<Result<Restored, String>>>,
    preview: tokio::sync::Mutex<Option<Preview>>,
}

/// A folder the backup's settings point to.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupPath {
    path: String,
    /// The setting it comes from (the first one, when several share the folder).
    key: String,
    /// Found on this computer (only checked when a backup is reviewed).
    exists: bool,
    /// Behind a network share TruongFlix connects to itself.
    share: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    version: i64,
    /// Passwords and keys are inside.
    secrets: bool,
    paths: Vec<BackupPath>,
    profiles: i64,
    titles: i64,
}

struct Preview {
    token: String,
    file: NamedTempFile,
}

#[derive(Serialize)]
pub struct BackupPreview {
    token: String,
    #[serde(flatten)]
    info: BackupInfo,
}

#[derive(Deserialize)]
pub struct FolderMapping {
    from: String,
    to: String,
}

/// What the UI finishes after a restore: preferences for the window's storage, and the folders
/// that aren't on this computer.
#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    local: BTreeMap<String, String>,
    missing: Vec<String>,
}

/// What goes into a backup besides the database.
#[derive(Default)]
struct Extras {
    /// Keychain values to put in (the user asked for passwords and keys). `None` leaves every
    /// secret out.
    secrets: Option<BTreeMap<String, String>>,
    /// Preferences from the window's storage.
    local: BTreeMap<String, String>,
    /// Where playlist covers are; `None` carries none.
    art_dir: Option<PathBuf>,
}

fn main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Backups are available in the main window only.".into())
    }
}

fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // This is the directory the SQL plugin uses for sqlite:truongflix.db.
    app.path()
        .app_config_dir()
        .map_err(|error| error.to_string())
}

unsafe extern "C" fn sql_guard(
    _: *mut c_void,
    action: c_int,
    _: *const c_char,
    arg2: *const c_char,
    _: *const c_char,
    _: *const c_char,
) -> c_int {
    match action {
        SQLITE_ATTACH | SQLITE_DETACH => SQLITE_DENY,
        SQLITE_FUNCTION if !arg2.is_null() && CStr::from_ptr(arg2).to_bytes().eq_ignore_ascii_case(b"load_extension") => SQLITE_DENY,
        _ => SQLITE_OK,
    }
}

unsafe extern "C" fn guard_connection(db: *mut sqlite3, _: *mut *mut c_char, _: *const sqlite3_api_routines) -> c_int {
    sqlite3_set_authorizer(db, Some(sql_guard), std::ptr::null_mut());
    SQLITE_OK
}

/// Every SQLite connection opened in this process (including the SQL plugin's pool, which the
/// web view can send arbitrary statements to) refuses ATTACH/DETACH — and with them `VACUUM INTO`
/// — and `load_extension()`, so SQL from the UI can't read or write other files. Backups, which
/// need ATTACH, lift the guard on their own connections.
pub fn install_sql_guard() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| unsafe {
        sqlite3_auto_extension(Some(guard_connection));
    });
}

async fn connect(
    path: &Path,
    read_only: bool,
    immutable: bool,
) -> Result<SqliteConnection, sqlx::Error> {
    let mut db = SqliteConnectOptions::new()
        .filename(path)
        .read_only(read_only)
        .immutable(immutable)
        .busy_timeout(Duration::from_secs(5))
        .pragma("trusted_schema", "OFF")
        .connect()
        .await?;
    {
        let mut handle = db.lock_handle().await?;
        unsafe { sqlite3_set_authorizer(handle.as_raw_handle().as_ptr(), None, std::ptr::null_mut()) };
    }
    Ok(db)
}

/// Folders the library manages according to the app's database: media folders, torrent save
/// folders and roots of earlier renames. File operations from the UI must stay inside these.
pub(crate) async fn library_folders(app: &AppHandle) -> Vec<PathBuf> {
    let Ok(dir) = app_dir(app) else { return Vec::new() };
    let Ok(mut db) = connect(&dir.join(DB), true, false).await else { return Vec::new() };
    let mut out: Vec<String> = Vec::new();
    let settings: Vec<(String, String)> = sqlx::query_as(
        "SELECT key, value FROM settings WHERE key IN ('media_directories', 'torrent_movies_dir', 'torrent_tv_dir')",
    )
    .fetch_all(&mut db)
    .await
    .unwrap_or_default();
    for (key, value) in settings {
        if key == "media_directories" {
            out.extend(serde_json::from_str::<Vec<String>>(&value).unwrap_or_default());
        } else {
            out.push(value);
        }
    }
    out.extend(sqlx::query_scalar::<_, String>("SELECT save_path FROM torrents").fetch_all(&mut db).await.unwrap_or_default());
    for roots in sqlx::query_scalar::<_, String>("SELECT roots FROM rename_batches").fetch_all(&mut db).await.unwrap_or_default() {
        out.extend(serde_json::from_str::<Vec<String>>(&roots).unwrap_or_default());
    }
    let _ = db.close().await;
    out.into_iter().filter(|p| !p.trim().is_empty()).map(|p| crate::files::dir_path(&p)).filter(|p| p.is_absolute()).collect()
}

/// The music folders from Settings (songs can only be deleted from these).
pub(crate) async fn music_folders(app: &AppHandle) -> Vec<PathBuf> {
    let Ok(dir) = app_dir(app) else { return Vec::new() };
    let Ok(mut db) = connect(&dir.join(DB), true, false).await else { return Vec::new() };
    let value: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'music_directories'").fetch_optional(&mut db).await.ok().flatten();
    let _ = db.close().await;
    serde_json::from_str::<Vec<String>>(&value.unwrap_or_default())
        .unwrap_or_default()
        .into_iter()
        .filter(|p| !p.trim().is_empty())
        .map(|p| crate::files::dir_path(&p))
        .filter(|p| p.is_absolute())
        .collect()
}

async fn copy_database(
    source: &mut SqliteConnection,
    dest: &mut SqliteConnection,
) -> Result<(), String> {
    let mut source = source
        .lock_handle()
        .await
        .map_err(|error| error.to_string())?;
    let mut dest = dest
        .lock_handle()
        .await
        .map_err(|error| error.to_string())?;
    // Both connections are exclusively locked while SQLite copies the snapshot in
    // one transaction. The engine handles concurrent writers and journal files.
    let (step, finish) = unsafe {
        let name = c"main".as_ptr();
        let handle = sqlite3_backup_init(
            dest.as_raw_handle().as_ptr(),
            name,
            source.as_raw_handle().as_ptr(),
            name,
        );
        if handle.is_null() {
            return Err("Could not start the SQLite backup.".into());
        }
        let step = sqlite3_backup_step(handle, -1);
        (step, sqlite3_backup_finish(handle))
    };
    if step == SQLITE_DONE && finish == SQLITE_OK {
        Ok(())
    } else {
        Err(format!(
            "Could not copy the database (SQLite error {step}/{finish})."
        ))
    }
}

fn sql_error(error: sqlx::Error) -> String {
    error.to_string()
}

/// `schema.table` exists (`schema` is `main` or `incoming`).
async fn has_table(db: &mut SqliteConnection, schema: &str, table: &str) -> Result<bool, sqlx::Error> {
    let found: Option<String> = sqlx::query_scalar(&format!("SELECT name FROM {schema}.sqlite_master WHERE type = 'table' AND name = ?"))
        .bind(table)
        .fetch_optional(db)
        .await?;
    Ok(found.is_some())
}

async fn has_column(db: &mut SqliteConnection, table: &str, column: &str) -> Result<bool, sqlx::Error> {
    Ok(columns(db, table).await?.iter().any(|c| c == column))
}

/// Playlist covers named in the database that are in `art_dir`.
async fn art_files(db: &mut SqliteConnection, art_dir: &Path) -> Result<Vec<(String, Vec<u8>)>, sqlx::Error> {
    let mut names = std::collections::BTreeSet::new();
    for (table, column) in ART_COLUMNS {
        if !has_column(db, table, column).await? {
            continue;
        }
        let found: Vec<String> = sqlx::query_scalar(&format!("SELECT DISTINCT {column} FROM {table} WHERE {column} IS NOT NULL"))
            .fetch_all(&mut *db)
            .await?;
        names.extend(found.into_iter().filter(|name| crate::music::valid_art_name(name)));
    }
    let mut out = Vec::new();
    for name in names {
        let path = art_dir.join(&name);
        // A cover that's gone just isn't carried: the playlist shows its songs' covers.
        let Ok(meta) = fs::metadata(&path) else { continue };
        if !meta.is_file() || meta.len() > MAX_ITEM_BYTES {
            continue;
        }
        if let Ok(data) = fs::read(&path) {
            out.push((name, data));
        }
    }
    Ok(out)
}

async fn snapshot(source: &Path, destination: &Path, extras: &Extras) -> Result<(), String> {
    let parent = destination.parent().ok_or("Choose a destination folder.")?;
    let temp = NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    let mut input = connect(source, true, false)
        .await
        .map_err(|error| error.to_string())?;
    let mut output = connect(temp.path(), false, false)
        .await
        .map_err(|error| error.to_string())?;
    copy_database(&mut input, &mut output).await?;
    input.close().await.map_err(sql_error)?;
    for pragma in [
        "PRAGMA journal_mode = DELETE".to_string(),
        format!("PRAGMA application_id = {APPLICATION_ID}"),
        format!("PRAGMA user_version = {VERSION}"),
        "PRAGMA secure_delete = ON".to_string(),
    ] {
        sqlx::query(&pragma).execute(&mut output).await.map_err(sql_error)?;
    }
    for table in &manifest().tables.local {
        if has_table(&mut output, "main", table).await.map_err(sql_error)? {
            sqlx::query(&format!("DELETE FROM \"{table}\"")).execute(&mut output).await.map_err(sql_error)?;
        }
    }
    match &extras.secrets {
        None => {
            sqlx::query(&format!("DELETE FROM settings WHERE key IN ({})", secret_list()))
                .execute(&mut output)
                .await
                .map_err(sql_error)?;
        }
        // A settings row wins over the keychain in the app, so it wins here too.
        Some(values) => {
            let values: Vec<(&String, &String)> = values.iter().filter(|(key, _)| crate::secrets::KEYS.contains(&key.as_str())).collect();
            for (key, value) in values {
                sqlx::query("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
                    .bind(key)
                    .bind(value)
                    .execute(&mut output)
                    .await
                    .map_err(sql_error)?;
            }
        }
    }
    for table in [
        "CREATE TABLE backup_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        "CREATE TABLE backup_local (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        "CREATE TABLE backup_files (folder TEXT NOT NULL, name TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY (folder, name))",
    ] {
        sqlx::query(table).execute(&mut output).await.map_err(sql_error)?;
    }
    let made = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    for (key, value) in [
        ("secrets", if extras.secrets.is_some() { "1" } else { "0" }.to_string()),
        ("app_version", env!("CARGO_PKG_VERSION").to_string()),
        ("made_at", made.to_string()),
    ] {
        sqlx::query("INSERT INTO backup_meta (key, value) VALUES (?, ?)").bind(key).bind(value).execute(&mut output).await.map_err(sql_error)?;
    }
    let local: Vec<(&String, &String)> = carried_local(&extras.local).collect();
    for (key, value) in local {
        sqlx::query("INSERT INTO backup_local (key, value) VALUES (?, ?)").bind(key).bind(value).execute(&mut output).await.map_err(sql_error)?;
    }
    if let Some(art_dir) = &extras.art_dir {
        for (name, data) in art_files(&mut output, art_dir).await.map_err(sql_error)? {
            sqlx::query("INSERT INTO backup_files (folder, name, data) VALUES (?, ?, ?)")
                .bind(ART_FOLDER)
                .bind(name)
                .bind(data)
                .execute(&mut output)
                .await
                .map_err(sql_error)?;
        }
    }
    output.close().await.map_err(|error| error.to_string())?;
    check_file(temp.path())?;
    temp.as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temp.persist(destination)
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// The window-storage preferences a backup carries (others, and oversized ones, are dropped).
fn carried_local(local: &BTreeMap<String, String>) -> impl Iterator<Item = (&String, &String)> {
    local
        .iter()
        .filter(|(key, value)| manifest().local_storage.carry.contains(key) && value.len() as u64 <= MAX_ITEM_BYTES)
}

/// Folders the settings point to (none for settings that are missing or damaged).
async fn settings_paths(db: &mut SqliteConnection) -> Result<Vec<BackupPath>, sqlx::Error> {
    let keys: Vec<&str> = folder_keys().chain(manifest().settings.shares.iter().map(String::as_str)).collect();
    let rows: Vec<(String, String)> = sqlx::query_as(&format!("SELECT key, value FROM settings WHERE key IN ({})", sql_list(&keys)))
        .fetch_all(db)
        .await?;
    let get = |key: &str| rows.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
    let shared: HashSet<String> = manifest()
        .settings
        .shares
        .iter()
        .filter_map(|key| get(key))
        .filter_map(|raw| serde_json::from_str::<serde_json::Map<String, Value>>(raw).ok())
        .flat_map(|shares| shares.into_iter().map(|(folder, _)| folder))
        .collect();
    let mut out: Vec<BackupPath> = Vec::new();
    for key in folder_keys() {
        let Some(raw) = get(key) else { continue };
        let paths = if manifest().settings.folders.iter().any(|k| k == key) {
            serde_json::from_str::<Vec<Value>>(raw)
                .unwrap_or_default()
                .into_iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        } else {
            vec![raw.to_owned()]
        };
        for path in paths.into_iter().filter(|p| !p.trim().is_empty()) {
            if !out.iter().any(|p| p.path == path) {
                out.push(BackupPath { share: shared.contains(&path), path, key: key.to_owned(), exists: false });
            }
        }
    }
    Ok(out)
}

async fn inspect(db: &mut SqliteConnection) -> Result<BackupInfo, String> {
    let id: i64 = sqlx::query_scalar("PRAGMA application_id")
        .fetch_one(&mut *db)
        .await
        .map_err(|_| "This file is not a TruongFlix backup.")?;
    if id != APPLICATION_ID {
        return Err("This file is not a TruongFlix backup.".into());
    }
    let version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut *db)
        .await
        .map_err(|_| "Could not read the backup version.")?;
    if version > VERSION {
        return Err("This backup is from a newer TruongFlix. Update TruongFlix, then restore it.".into());
    }
    if version < OLDEST {
        return Err("This backup requires a compatible version of TruongFlix.".into());
    }
    let result: Vec<String> = sqlx::query_scalar("PRAGMA quick_check(1)")
        .fetch_all(&mut *db)
        .await
        .map_err(|_| "The backup could not be verified.")?;
    if result.as_slice() != ["ok"] {
        return Err("The backup is damaged.".into());
    }
    let unsafe_schema: i64 =
        sqlx::query_scalar("SELECT count(*) FROM pragma_table_list WHERE type <> 'table'")
            .fetch_one(&mut *db)
            .await
            .map_err(|_| "Could not check the backup schema.")?;
    let triggers: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sqlite_schema WHERE type = 'trigger'")
            .fetch_one(&mut *db)
            .await
            .map_err(|_| "Could not check the backup schema.")?;
    if unsafe_schema != 0 || triggers != 0 {
        return Err("The backup contains an unsupported database schema.".into());
    }
    let paths = settings_paths(db).await.map_err(|_| "The backup is missing its settings.")?;
    let secrets = if has_table(db, "main", "backup_meta").await.map_err(sql_error)? {
        let flag: Option<String> = sqlx::query_scalar("SELECT value FROM backup_meta WHERE key = 'secrets'")
            .fetch_optional(&mut *db)
            .await
            .map_err(sql_error)?;
        flag.as_deref() == Some("1")
    } else {
        false
    };
    let (profiles, titles) = sqlx::query_as("SELECT (SELECT count(*) FROM profiles), (SELECT count(*) FROM movies) + (SELECT count(*) FROM tv_series)")
        .fetch_one(&mut *db).await.map_err(|_| "The backup is missing its library or profiles.")?;
    Ok(BackupInfo {
        version,
        secrets,
        paths,
        profiles,
        titles,
    })
}

fn check_file(path: &Path) -> Result<(), String> {
    let meta = fs::metadata(path).map_err(|error| error.to_string())?;
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return Err("Choose a TruongFlix backup file smaller than 512 MB.".into());
    }
    Ok(())
}

/// Match a whole folder prefix, including paths saved on the other desktop OS.
fn remap_path(path: &str, mappings: &[FolderMapping]) -> Option<String> {
    for mapping in mappings {
        let from = &mapping.from;
        let windows = from.as_bytes().get(1) == Some(&b':') || from.starts_with("\\\\");
        let normalize = |text: &str| {
            if windows {
                text.replace('\\', "/").to_ascii_lowercase()
            } else {
                text.to_owned()
            }
        };
        let old = normalize(from);
        let old = old.trim_end_matches('/');
        let normalized = normalize(path);
        let Some(rest) = normalized.strip_prefix(old) else {
            continue;
        };
        if !rest.is_empty() && !rest.starts_with('/') {
            continue;
        }
        // Normalization preserves byte length, so use the original casing for the suffix.
        let suffix = &path[old.len()..];
        let separator = |c| c == '/' || (windows && c == '\\');
        let mut new_path = PathBuf::from(&mapping.to);
        for part in suffix.split(separator).filter(|part| !part.is_empty()) {
            if part == "."
                || part == ".."
                || Path::new(part).components().count() != 1
                || !matches!(
                    Path::new(part).components().next(),
                    Some(std::path::Component::Normal(_))
                )
            {
                return None;
            }
            new_path.push(part);
        }
        return Some(new_path.to_string_lossy().into_owned());
    }
    None
}

async fn remap_folders(
    db: &mut SqliteConnection,
    mappings: &[FolderMapping],
) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;
    for (table, column) in PATH_COLUMNS {
        // Music's and Games' tables only exist once they have been opened.
        if !has_column(&mut tx, table, column).await? {
            continue;
        }
        let read = format!("SELECT rowid, {column} FROM {table} WHERE {column} IS NOT NULL");
        let update = format!("UPDATE {table} SET {column} = ? WHERE rowid = ?");
        let rows: Vec<(i64, String)> = sqlx::query_as(&read).fetch_all(&mut *tx).await?;
        for (id, current) in rows {
            if let Some(next) = remap_path(&current, mappings).filter(|next| next != &current) {
                sqlx::query(&update)
                    .bind(next)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }
    let s = &manifest().settings;
    let keys: Vec<&String> = s.folders.iter().chain(&s.folder).chain(&s.file).chain(&s.shares).collect();
    let rows = sqlx::query(&format!("SELECT key, value FROM settings WHERE key IN ({})", sql_list(&keys)))
        .fetch_all(&mut *tx)
        .await?;
    for row in rows {
        let key: String = row.get(0);
        let raw: String = row.get(1);
        let next = if s.folders.contains(&key) {
            serde_json::from_str::<Vec<String>>(&raw).ok().map(|folders| {
                let folders: Vec<_> = folders
                    .into_iter()
                    .map(|folder| remap_path(&folder, mappings).unwrap_or(folder))
                    .collect();
                serde_json::to_string(&folders).expect("strings serialize")
            })
        } else if s.shares.contains(&key) {
            // A relinked folder is no longer behind the share it was on.
            serde_json::from_str::<serde_json::Map<String, Value>>(&raw).ok().map(|mut shares| {
                shares.retain(|folder, _| remap_path(folder, mappings).is_none());
                Value::Object(shares).to_string()
            })
        } else {
            remap_path(&raw, mappings)
        };
        if let Some(next) = next {
            sqlx::query("UPDATE settings SET value = ? WHERE key = ?")
                .bind(next)
                .bind(key)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await
}

#[tauri::command]
pub async fn backup_export(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, BackupState>,
    path: PathBuf,
    include_secrets: Option<bool>,
    local: Option<BTreeMap<String, String>>,
) -> Result<(), String> {
    main_window(&window)?;
    let _lock = state.operation.lock().await;
    if path.extension().and_then(|e| e.to_str()) != Some("truongflix-backup") {
        return Err("Use the .truongflix-backup file extension.".into());
    }
    let dir = app_dir(&app)?;
    if path == dir.join(RECOVERY) {
        return Err("Choose a different location for this backup.".into());
    }
    let secrets = if include_secrets.unwrap_or(false) {
        // macOS keeps them in the database (no keychain there), which the snapshot already has.
        let values = tauri::async_runtime::spawn_blocking(crate::secrets::stored_values)
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| format!("Couldn't read the passwords and keys: {error}"))?;
        Some(values)
    } else {
        None
    };
    let extras = Extras { secrets, local: local.unwrap_or_default(), art_dir: Some(crate::music::art_dir(&app)) };
    snapshot(&dir.join(DB), &path, &extras).await
}

async fn columns(db: &mut SqliteConnection, table: &str) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT name FROM pragma_table_info(?) ORDER BY cid")
        .bind(table)
        .fetch_all(db)
        .await
}

/// Columns of a table here that must be given a value (NOT NULL, no default, not the row id).
async fn required_columns(db: &mut SqliteConnection, table: &str) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT name FROM pragma_table_info(?) WHERE \"notnull\" = 1 AND dflt_value IS NULL AND pk = 0")
        .bind(table)
        .fetch_all(db)
        .await
}

/// For each portable table, the columns to copy: those both the backup and this computer have.
/// Columns added by a later update just take their defaults, and columns this version doesn't
/// know are left behind. `None`: an optional table one side doesn't have, left as it is.
async fn check_schema(
    source: &mut SqliteConnection,
    destination: &mut SqliteConnection,
) -> Result<Vec<Option<Vec<String>>>, String> {
    let mut tables = Vec::new();
    for table in portable_tables() {
        let source_cols = columns(source, table)
            .await
            .map_err(|error| error.to_string())?;
        let dest_cols = columns(destination, table)
            .await
            .map_err(|error| error.to_string())?;
        if is_optional(table) && (source_cols.is_empty() || dest_cols.is_empty()) {
            tables.push(None);
            continue;
        }
        if dest_cols.is_empty() || source_cols.is_empty() {
            return Err(format!("The backup is missing required data in {table}."));
        }
        let required = required_columns(destination, table)
            .await
            .map_err(|error| error.to_string())?;
        if required.iter().any(|column| !source_cols.contains(column)) {
            return Err(format!("The backup is missing required data in {table}."));
        }
        tables.push(Some(dest_cols.into_iter().filter(|column| source_cols.contains(column)).collect()));
    }
    Ok(tables)
}

fn copy_file(dir: &Path, path: &Path) -> Result<NamedTempFile, String> {
    check_file(path)?;
    let mut input = fs::File::open(path)
        .map_err(|error| error.to_string())?
        .take(MAX_BYTES + 1);
    let mut temp = NamedTempFile::new_in(dir).map_err(|error| error.to_string())?;
    if std::io::copy(&mut input, &mut temp).map_err(|error| error.to_string())? > MAX_BYTES {
        return Err("The backup exceeds 512 MB.".into());
    }
    temp.flush().map_err(|error| error.to_string())?;
    Ok(temp)
}

#[tauri::command]
pub async fn backup_inspect(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, BackupState>,
    path: PathBuf,
) -> Result<BackupPreview, String> {
    main_window(&window)?;
    let _lock = state.operation.lock().await;
    let dir = app_dir(&app)?;
    let copy_dir = dir.clone();
    let file = tauri::async_runtime::spawn_blocking(move || copy_file(&copy_dir, &path))
        .await
        .map_err(|error| error.to_string())??;
    let mut source = connect(file.path(), true, true)
        .await
        .map_err(|_| "Could not open the backup file.")?;
    let mut info = inspect(&mut source).await?;
    let mut dest = connect(&dir.join(DB), true, false)
        .await
        .map_err(|error| error.to_string())?;
    check_schema(&mut source, &mut dest).await?;
    source.close().await.map_err(|error| error.to_string())?;
    let mut paths = std::mem::take(&mut info.paths);
    info.paths = tauri::async_runtime::spawn_blocking(move || {
        for path in &mut paths {
            path.exists = Path::new(&path.path).is_dir();
        }
        paths
    })
    .await
    .map_err(|error| error.to_string())?;
    let mut nonce = [0; 16];
    getrandom::getrandom(&mut nonce).map_err(|error| error.to_string())?;
    let token: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
    *state.preview.lock().await = Some(Preview {
        token: token.clone(),
        file,
    });
    Ok(BackupPreview { token, info })
}

async fn stage(dir: &Path, path: &Path, mut mappings: Vec<FolderMapping>) -> Result<(), String> {
    let copy_dir = dir.to_path_buf();
    let copy_path = path.to_path_buf();
    let temp = tauri::async_runtime::spawn_blocking(move || copy_file(&copy_dir, &copy_path))
        .await
        .map_err(|error| error.to_string())??;
    let mut db = connect(temp.path(), false, false)
        .await
        .map_err(|_| "Could not open the backup file.")?;
    let info = inspect(&mut db).await?;
    let mut seen = HashSet::new();
    for mapping in &mappings {
        if !info.paths.iter().any(|p| p.path == mapping.from) || !seen.insert(&mapping.from) {
            return Err("The folder list in the backup changed. Select the backup again.".into());
        }
        let to = Path::new(&mapping.to);
        if !to.is_absolute() || !to.is_dir() {
            return Err(format!(
                "The replacement folder is unavailable: {}",
                mapping.to
            ));
        }
    }
    mappings.sort_by_key(|mapping| std::cmp::Reverse(mapping.from.len()));
    if !mappings.is_empty() {
        remap_folders(&mut db, &mappings).await.map_err(|_| {
            "Could not relink the backup to those folders. Check for overlapping paths."
        })?;
    }
    db.close().await.map_err(|error| error.to_string())?;
    temp.as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temp.persist(dir.join(PENDING))
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn backup_stage_restore(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, BackupState>,
    token: String,
    mappings: Vec<FolderMapping>,
) -> Result<(), String> {
    main_window(&window)?;
    let _lock = state.operation.lock().await;
    let mut preview = state.preview.lock().await;
    let candidate = preview
        .as_ref()
        .filter(|candidate| candidate.token == token)
        .ok_or("Select the backup again before restoring.")?;
    stage(&app_dir(&app)?, candidate.file.path(), mappings).await?;
    preview.take();
    app.request_restart();
    Ok(())
}

/// Puts the backup's playlist covers in `art_dir` (names are made from the picture, so one
/// that's already there is the same picture).
async fn restore_art(db: &mut SqliteConnection, art_dir: &Path) -> Result<(), String> {
    if !has_table(db, "incoming", "backup_files").await.map_err(sql_error)? {
        return Ok(());
    }
    let files: Vec<(String, Vec<u8>)> = sqlx::query_as("SELECT name, data FROM incoming.backup_files WHERE folder = ?")
        .bind(ART_FOLDER)
        .fetch_all(&mut *db)
        .await
        .map_err(sql_error)?;
    let files: Vec<_> = files
        .into_iter()
        .filter(|(name, data)| crate::music::valid_art_name(name) && data.len() as u64 <= MAX_ITEM_BYTES && !art_dir.join(name).is_file())
        .collect();
    if files.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(art_dir).map_err(|error| format!("Could not save the playlist covers: {error}"))?;
    for (name, data) in files {
        let mut temp = NamedTempFile::new_in(art_dir).map_err(|error| error.to_string())?;
        temp.write_all(&data).map_err(|error| error.to_string())?;
        temp.persist(art_dir.join(name)).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Songs whose cover isn't in this computer's cover folder are read again at the next scan
/// (a cover is made when a song is read, and an unchanged song isn't read again).
async fn rescan_missing_art(db: &mut SqliteConnection, art_dir: &Path) -> Result<(), sqlx::Error> {
    if !has_column(db, "music_tracks", "art").await? || !has_column(db, "music_tracks", "file_mtime").await? {
        return Ok(());
    }
    let names: Vec<String> = sqlx::query_scalar("SELECT DISTINCT art FROM main.music_tracks WHERE art IS NOT NULL")
        .fetch_all(&mut *db)
        .await?;
    let missing: Vec<String> = names.into_iter().filter(|name| !art_dir.join(name).is_file()).collect();
    for chunk in missing.chunks(400) {
        let marks = vec!["?"; chunk.len()].join(", ");
        let update = format!("UPDATE main.music_tracks SET art = NULL, file_mtime = 0 WHERE art IN ({marks})");
        let mut query = sqlx::query(&update);
        for name in chunk {
            query = query.bind(name);
        }
        query.execute(&mut *db).await?;
    }
    Ok(())
}

/// `local_secrets`: secret settings this computer keeps in its keychain. A backup without passwords
/// and keys (or an older one that still holds some) must not override those (a settings row takes
/// precedence over the keychain). A backup made with them replaces the ones it has.
///
/// Everything in the database is replaced in one transaction: on any error nothing changes.
async fn apply_restore(dir: &Path, pending: &Path, local_secrets: &[String], art_dir: Option<&Path>) -> Result<Restored, String> {
    let mut source = connect(pending, true, true)
        .await
        .map_err(|error| error.to_string())?;
    let info = inspect(&mut source).await?;
    let live = dir.join(DB);
    let mut dest = connect(&live, false, false)
        .await
        .map_err(|error| error.to_string())?;
    let column_sets = check_schema(&mut source, &mut dest).await?;
    source.close().await.map_err(|error| error.to_string())?;
    snapshot(&live, &dir.join(RECOVERY), &Extras { art_dir: art_dir.map(Path::to_path_buf), ..Default::default() })
        .await
        .map_err(|error| format!("Could not save your current data before restoring. {error}"))?;
    let mut uri = tauri::Url::from_file_path(pending).map_err(|_| "Invalid backup file path.")?;
    uri.query_pairs_mut()
        .append_pair("mode", "ro")
        .append_pair("immutable", "1");
    sqlx::query("ATTACH DATABASE ? AS incoming")
        .bind(uri.as_str())
        .execute(&mut dest)
        .await
        .map_err(|error| error.to_string())?;

    // Files first: a restore that fails later leaves only spare covers in the cache.
    if let Some(art_dir) = art_dir {
        restore_art(&mut dest, art_dir).await?;
    }
    let mut local = BTreeMap::new();
    if has_table(&mut dest, "incoming", "backup_local").await.map_err(sql_error)? {
        let rows: Vec<(String, String)> = sqlx::query_as("SELECT key, value FROM incoming.backup_local")
            .fetch_all(&mut dest)
            .await
            .map_err(sql_error)?;
        let rows: BTreeMap<String, String> = rows.into_iter().collect();
        local = carried_local(&rows).map(|(k, v)| (k.clone(), v.clone())).collect();
    }

    let mut tx = dest.begin().await.map_err(|error| error.to_string())?;
    let tables = portable_tables();
    let carried = sql_list(&carried_with_secrets());
    for (table, columns) in tables.iter().zip(&column_sets).rev() {
        if columns.is_none() {
            continue; // an optional table one side doesn't have: what's here stays
        }
        let keep = match *table {
            // The backup's passwords and keys replace these; the ones it doesn't have stay.
            "settings" if info.secrets => format!(" WHERE key NOT IN ({carried}) OR key IN (SELECT key FROM incoming.settings)"),
            // Passwords, keys and their account settings set on this computer stay.
            "settings" => format!(" WHERE key NOT IN ({carried})"),
            _ => String::new(),
        };
        sqlx::query(&format!("DELETE FROM main.{table}{keep}"))
            .execute(&mut *tx)
            .await
            .map_err(|error| error.to_string())?;
    }
    for (table, columns) in tables.iter().zip(column_sets.iter()) {
        let Some(columns) = columns else { continue };
        if columns.is_empty() {
            continue; // nothing in common (every column here has a default): left empty
        }
        // The identifiers come from the live schema, not from the backup file.
        let columns = columns
            .iter()
            .map(|name| format!("\"{}\"", name.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(", ");
        let (insert, filter) = match *table {
            "settings" if info.secrets => ("INSERT OR REPLACE", String::new()),
            // An older backup may still fill in secrets this computer doesn't have.
            "settings" => {
                let mut kept: Vec<&str> = local_secrets.iter().map(String::as_str).collect();
                kept.extend(manifest().settings.account.iter().map(String::as_str));
                ("INSERT OR IGNORE", format!(" WHERE key NOT IN ({})", sql_list(&kept)))
            }
            _ => ("INSERT", String::new()),
        };
        sqlx::query(&format!(
            "{insert} INTO main.{table} ({columns}) SELECT {columns} FROM incoming.{table}{filter}"
        ))
        .execute(&mut *tx)
        .await
        .map_err(|error| format!("Could not restore {table}: {error}"))?;
    }
    let songs_restored = tables.iter().zip(&column_sets).any(|(table, columns)| *table == "music_tracks" && columns.is_some());
    if let Some(art_dir) = art_dir.filter(|_| songs_restored) {
        rescan_missing_art(&mut tx, art_dir).await.map_err(|error| format!("Could not restore music_tracks: {error}"))?;
    }
    tx.commit().await.map_err(|error| error.to_string())?;

    // Kept as they are: shown so they can be relinked in Settings.
    let missing = settings_paths(&mut dest)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|p| !p.share && !Path::new(&p.path).is_dir())
        .map(|p| p.path)
        .collect();
    let _ = dest.close().await;
    Ok(Restored { local, missing })
}

pub fn restore_at_startup(app: &AppHandle) {
    let Ok(dir) = app_dir(app) else { return };
    let pending = dir.join(PENDING);
    if !pending.is_file() {
        return;
    }
    // Claim the request before applying it. A crash cannot silently replay the restore.
    let claimed = dir.join("restore-in-progress.db");
    let result = match fs::rename(&pending, &claimed) {
        Ok(()) => {
            // If the keychain can't be read, keep every secret out of the restore to be safe.
            let local_secrets = crate::secrets::stored_keys()
                .unwrap_or_else(|_| crate::secrets::KEYS.iter().map(|k| k.to_string()).collect());
            let art_dir = crate::music::art_dir(app);
            let result = tauri::async_runtime::block_on(apply_restore(&dir, &claimed, &local_secrets, Some(&art_dir)));
            let _ = fs::remove_file(claimed);
            result
        }
        Err(error) => Err(error.to_string()),
    };
    *app.state::<BackupState>().result.lock().unwrap() = Some(result);
}

/// After a restart that restored a backup: what the UI finishes (`None` when nothing was restored).
#[tauri::command]
pub fn backup_restore_result(
    window: WebviewWindow,
    state: State<'_, BackupState>,
) -> Result<Option<Restored>, String> {
    main_window(&window)?;
    state
        .result
        .lock()
        .unwrap()
        .take()
        .transpose()
}

#[tauri::command]
pub fn backup_recovery_path(
    window: WebviewWindow,
    app: AppHandle,
) -> Result<Option<PathBuf>, String> {
    main_window(&window)?;
    let path = app_dir(&app)?.join(RECOVERY);
    Ok(path.is_file().then_some(path))
}

#[cfg(test)]
mod tests;
