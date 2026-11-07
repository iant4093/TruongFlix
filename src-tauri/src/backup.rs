//! Portable SQLite snapshots. Restore runs before the application's connection pool opens.
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
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tempfile::NamedTempFile;

const DB: &str = "truongflix.db";
const PENDING: &str = "restore-pending.db";
const RECOVERY: &str = "Before restore.truongflix-backup";
const APPLICATION_ID: i64 = 0x5452_4658; // TRFX
const VERSION: i64 = 1;
const MAX_BYTES: u64 = 512 * 1024 * 1024;
// Keep file-operation history and transfer sessions local to their original installation.
const PORTABLE_TABLES: &[&str] = &[
    "settings",
    "profiles",
    "movies",
    "tv_series",
    "episodes",
    "subtitles",
    "profile_state",
    "watch_log",
    "browse_saved",
    "collections",
    "season_cache",
    "live_data",
    "live_viewing",
];

/// Account keys, passwords and the browser access code never leave this computer in a backup;
/// restoring keeps the ones already set here.
const SECRET_SETTINGS: &[&str] = &[
    "tmdb_api_key",
    "omdb_api_key",
    "opensubtitles_api_key",
    "opensubtitles_username",
    "opensubtitles_password",
    "remote_code",
];

fn secret_list() -> String {
    SECRET_SETTINGS.iter().map(|k| format!("'{k}'")).collect::<Vec<_>>().join(", ")
}

#[derive(Default)]
pub struct BackupState {
    operation: tokio::sync::Mutex<()>,
    result: Mutex<Option<Result<(), String>>>,
    preview: tokio::sync::Mutex<Option<Preview>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    folders: Vec<String>,
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
    out.into_iter().filter(|p| !p.trim().is_empty() && Path::new(p).is_absolute()).map(PathBuf::from).collect()
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

async fn snapshot(source: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination.parent().ok_or("Choose a destination folder.")?;
    let temp = NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    let mut input = connect(source, true, false)
        .await
        .map_err(|error| error.to_string())?;
    let mut output = connect(temp.path(), false, false)
        .await
        .map_err(|error| error.to_string())?;
    copy_database(&mut input, &mut output).await?;
    sqlx::query("PRAGMA journal_mode = DELETE")
        .execute(&mut output)
        .await
        .map_err(|error| error.to_string())?;
    sqlx::query(&format!("PRAGMA application_id = {APPLICATION_ID}"))
        .execute(&mut output)
        .await
        .map_err(|error| error.to_string())?;
    sqlx::query(&format!("PRAGMA user_version = {VERSION}"))
        .execute(&mut output)
        .await
        .map_err(|error| error.to_string())?;
    let drop_secrets = format!("DELETE FROM settings WHERE key IN ({})", secret_list());
    for statement in [
        "PRAGMA secure_delete = ON",
        "DELETE FROM trash",
        "DELETE FROM rename_batches",
        "DELETE FROM torrents",
        &drop_secrets,
    ] {
        sqlx::query(statement)
            .execute(&mut output)
            .await
            .map_err(|error| error.to_string())?;
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
    if version != VERSION {
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
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'media_directories'")
            .fetch_optional(&mut *db)
            .await
            .map_err(|_| "The backup is missing its settings.")?;
    let folders = match raw {
        Some(value) => {
            serde_json::from_str(&value).map_err(|_| "The backup's media folders are invalid.")?
        }
        None => Vec::new(),
    };
    let (profiles, titles) = sqlx::query_as("SELECT (SELECT count(*) FROM profiles), (SELECT count(*) FROM movies) + (SELECT count(*) FROM tv_series)")
        .fetch_one(&mut *db).await.map_err(|_| "The backup is missing its library or profiles.")?;
    Ok(BackupInfo {
        folders,
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
    for (table, column) in [
        ("movies", "file_path"),
        ("episodes", "file_path"),
        ("tv_series", "folder_path"),
        ("subtitles", "file_path"),
    ] {
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
    let rows = sqlx::query("SELECT key, value FROM settings WHERE key IN ('media_directories', 'network_shares', 'torrent_movies_dir', 'torrent_tv_dir')")
        .fetch_all(&mut *tx).await?;
    for row in rows {
        let key: String = row.get(0);
        let raw: String = row.get(1);
        let next = match key.as_str() {
            "media_directories" => serde_json::from_str::<Vec<String>>(&raw)
                .ok()
                .map(|folders| {
                    let folders: Vec<_> = folders
                        .into_iter()
                        .map(|folder| remap_path(&folder, mappings).unwrap_or(folder))
                        .collect();
                    serde_json::to_string(&folders).expect("strings serialize")
                }),
            "network_shares" => serde_json::from_str::<serde_json::Map<String, Value>>(&raw)
                .ok()
                .map(|mut shares| {
                    shares.retain(|folder, _| remap_path(folder, mappings).is_none());
                    Value::Object(shares).to_string()
                }),
            _ => remap_path(&raw, mappings),
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
    snapshot(&dir.join(DB), &path).await
}

async fn columns(db: &mut SqliteConnection, table: &str) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT name FROM pragma_table_info(?) ORDER BY cid")
        .bind(table)
        .fetch_all(db)
        .await
}

async fn check_schema(
    source: &mut SqliteConnection,
    destination: &mut SqliteConnection,
) -> Result<Vec<Vec<String>>, String> {
    let mut tables = Vec::new();
    for table in PORTABLE_TABLES {
        let source_cols = columns(source, table)
            .await
            .map_err(|error| error.to_string())?;
        let dest_cols = columns(destination, table)
            .await
            .map_err(|error| error.to_string())?;
        if dest_cols.is_empty() || !dest_cols.iter().all(|column| source_cols.contains(column)) {
            return Err(format!("The backup is missing required data in {table}."));
        }
        tables.push(dest_cols);
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
    let info = inspect(&mut source).await?;
    let mut dest = connect(&dir.join(DB), true, false)
        .await
        .map_err(|error| error.to_string())?;
    check_schema(&mut source, &mut dest).await?;
    source.close().await.map_err(|error| error.to_string())?;
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
    let mut seen = std::collections::HashSet::new();
    for mapping in &mappings {
        if !info.folders.contains(&mapping.from) || !seen.insert(&mapping.from) {
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

async fn apply_restore(dir: &Path, pending: &Path) -> Result<(), String> {
    let mut source = connect(pending, true, true)
        .await
        .map_err(|error| error.to_string())?;
    inspect(&mut source).await?;
    let live = dir.join(DB);
    let mut dest = connect(&live, false, false)
        .await
        .map_err(|error| error.to_string())?;
    let column_sets = check_schema(&mut source, &mut dest).await?;
    source.close().await.map_err(|error| error.to_string())?;
    snapshot(&live, &dir.join(RECOVERY))
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

    let mut tx = dest.begin().await.map_err(|error| error.to_string())?;
    let secrets = secret_list();
    for table in PORTABLE_TABLES.iter().rev() {
        // Secrets set on this computer stay; older backups may still fill in missing ones.
        let keep = if *table == "settings" { format!(" WHERE key NOT IN ({secrets})") } else { String::new() };
        sqlx::query(&format!("DELETE FROM main.{table}{keep}"))
            .execute(&mut *tx)
            .await
            .map_err(|error| error.to_string())?;
    }
    for (table, columns) in PORTABLE_TABLES.iter().zip(column_sets) {
        // The identifiers come from the live schema, not from the backup file.
        let columns = columns
            .iter()
            .map(|name| format!("\"{}\"", name.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(", ");
        let insert = if *table == "settings" { "INSERT OR IGNORE" } else { "INSERT" };
        sqlx::query(&format!(
            "{insert} INTO main.{table} ({columns}) SELECT {columns} FROM incoming.{table}"
        ))
        .execute(&mut *tx)
        .await
        .map_err(|error| format!("Could not restore {table}: {error}"))?;
    }
    tx.commit().await.map_err(|error| error.to_string())?;
    Ok(())
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
            let result = tauri::async_runtime::block_on(apply_restore(&dir, &claimed));
            let _ = fs::remove_file(claimed);
            result
        }
        Err(error) => Err(error.to_string()),
    };
    *app.state::<BackupState>().result.lock().unwrap() = Some(result);
}

#[tauri::command]
pub fn backup_restore_result(
    window: WebviewWindow,
    state: State<'_, BackupState>,
) -> Result<bool, String> {
    main_window(&window)?;
    state
        .result
        .lock()
        .unwrap()
        .take()
        .transpose()
        .map(|result| result.is_some())
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
mod tests {
    use super::*;

    async fn fixture(dir: &Path) -> SqliteConnection {
        let file = dir.join(DB);
        fs::File::create(&file).unwrap();
        let mut db = connect(&file, false, false).await.unwrap();
        sqlx::raw_sql("
            PRAGMA journal_mode = WAL;
            PRAGMA wal_autocheckpoint = 0;
            CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
            INSERT INTO settings VALUES ('media_directories', '[\"/old/Movies\"]');
            CREATE TABLE profiles(id INTEGER PRIMARY KEY, name TEXT);
            INSERT INTO profiles VALUES (1, 'Saved profile');
            CREATE TABLE movies(id INTEGER PRIMARY KEY, file_path TEXT UNIQUE);
            INSERT INTO movies VALUES (42, '/old/Movies/Favorites/Film.mkv');
            CREATE TABLE tv_series(id INTEGER PRIMARY KEY, folder_path TEXT);
            CREATE TABLE episodes(id INTEGER PRIMARY KEY, file_path TEXT);
            CREATE TABLE subtitles(id INTEGER PRIMARY KEY, file_path TEXT);
            CREATE TABLE torrents(save_path TEXT, source TEXT, file_paths TEXT);
            CREATE TABLE trash(entry_dir TEXT, items TEXT, snapshot TEXT);
            CREATE TABLE rename_batches(moves TEXT, roots TEXT);
            CREATE TABLE watch_log(profile_id INTEGER);
            CREATE TABLE collections(id INTEGER);
            CREATE TABLE season_cache(series_tmdb_id INTEGER);
            CREATE TABLE live_data(key TEXT);
            CREATE TABLE live_viewing(profile_id INTEGER);
            CREATE TABLE profile_state(profile_id INTEGER, media_id INTEGER, progress_seconds INTEGER);
            INSERT INTO profile_state VALUES (1, 42, 312);
            CREATE TABLE browse_saved(profile_id INTEGER, kind TEXT, tmdb_id INTEGER);
            INSERT INTO browse_saved VALUES (1, 'movie', 993);
        ").execute(&mut db).await.unwrap();
        db
    }

    #[tokio::test]
    async fn restores_a_live_snapshot_with_relinked_paths_and_preserves_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        let mut db = fixture(path).await;
        let file = path.join("saved.truongflix-backup");
        snapshot(&path.join(DB), &file).await.unwrap();
        sqlx::query("UPDATE profiles SET name = 'New profile'")
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();

        let target = path.join("Relinked");
        fs::create_dir(&target).unwrap();
        stage(
            path,
            &file,
            vec![FolderMapping {
                from: "/old/Movies".into(),
                to: target.to_string_lossy().into_owned(),
            }],
        )
        .await
        .unwrap();
        apply_restore(path, &path.join(PENDING)).await.unwrap();
        let mut restored = connect(&path.join(DB), true, false).await.unwrap();
        let library: (i64, String, i64) = sqlx::query_as("SELECT id, file_path, progress_seconds FROM movies JOIN profile_state ON movies.id = media_id")
            .fetch_one(&mut restored).await.unwrap();
        assert_eq!(
            library,
            (
                42,
                target
                    .join("Favorites")
                    .join("Film.mkv")
                    .to_string_lossy()
                    .into_owned(),
                312
            )
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT tmdb_id FROM browse_saved")
                .fetch_one(&mut restored)
                .await
                .unwrap(),
            993
        );

        let mut recovery = connect(&path.join(RECOVERY), true, true).await.unwrap();
        assert_eq!(inspect(&mut recovery).await.unwrap().profiles, 1);
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT name FROM profiles")
                .fetch_one(&mut recovery)
                .await
                .unwrap(),
            "New profile"
        );
    }

    #[tokio::test]
    async fn ui_connections_cannot_reach_other_files() {
        install_sql_guard();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("app.db");
        let other = dir.path().join("other.db");
        let mut db = SqliteConnectOptions::new().filename(&file).create_if_missing(true).connect().await.unwrap();
        sqlx::raw_sql("CREATE TABLE t(x); INSERT INTO t VALUES (1);").execute(&mut db).await.unwrap();
        let other_uri = other.to_string_lossy().replace('\'', "''");
        for sql in [
            format!("ATTACH DATABASE '{other_uri}' AS x"),
            format!("VACUUM INTO '{other_uri}'"),
            "DETACH DATABASE main".to_string(),
            "SELECT load_extension('evil')".to_string(),
        ] {
            assert!(sqlx::raw_sql(&sql).execute(&mut db).await.is_err(), "{sql}");
        }
        assert!(!other.exists());
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT x FROM t").fetch_one(&mut db).await.unwrap(), 1);
        // Backups lift the guard on their own connections.
        fs::File::create(&other).unwrap();
        let mut trusted = connect(&file, false, false).await.unwrap();
        sqlx::raw_sql(&format!("ATTACH DATABASE '{other_uri}' AS x; DETACH DATABASE x;")).execute(&mut trusted).await.unwrap();
    }

    #[tokio::test]
    async fn backups_leave_secrets_out_and_restores_keep_local_ones() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        let mut db = fixture(path).await;
        sqlx::raw_sql("INSERT INTO settings VALUES ('tmdb_api_key', 'old-key'), ('remote_code', '123456'), ('subtitle_language', 'fr');")
            .execute(&mut db)
            .await
            .unwrap();
        let file = path.join("saved.truongflix-backup");
        snapshot(&path.join(DB), &file).await.unwrap();
        let mut saved = connect(&file, true, true).await.unwrap();
        let keys: Vec<String> = sqlx::query_scalar("SELECT key FROM settings ORDER BY key").fetch_all(&mut saved).await.unwrap();
        assert_eq!(keys, ["media_directories", "subtitle_language"]);
        saved.close().await.unwrap();

        sqlx::raw_sql("UPDATE settings SET value = 'new-key' WHERE key = 'tmdb_api_key'; UPDATE settings SET value = 'de' WHERE key = 'subtitle_language';")
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
        stage(path, &file, Vec::new()).await.unwrap();
        apply_restore(path, &path.join(PENDING)).await.unwrap();
        let mut restored = connect(&path.join(DB), true, false).await.unwrap();
        let settings: Vec<(String, String)> = sqlx::query_as("SELECT key, value FROM settings ORDER BY key").fetch_all(&mut restored).await.unwrap();
        let get = |k: &str| settings.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        assert_eq!(get("tmdb_api_key"), Some("new-key"));
        assert_eq!(get("remote_code"), Some("123456"));
        assert_eq!(get("subtitle_language"), Some("fr"));
    }

    #[tokio::test]
    async fn rejects_a_non_backup_before_staging_any_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = fixture(dir.path()).await;
        let path = dir.path().join(DB);
        assert!(stage(dir.path(), &path, Vec::new()).await.is_err());
        assert!(!dir.path().join(PENDING).exists());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT id FROM movies")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            42
        );
    }

    #[tokio::test]
    async fn rejects_missing_columns_before_touching_the_library() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = fixture(dir.path()).await;
        let backup = dir.path().join(PENDING);
        snapshot(&dir.path().join(DB), &backup).await.unwrap();
        let mut damaged = connect(&backup, false, false).await.unwrap();
        sqlx::raw_sql("DROP TABLE movies; CREATE TABLE movies(id INTEGER PRIMARY KEY)")
            .execute(&mut damaged)
            .await
            .unwrap();
        damaged.close().await.unwrap();
        assert!(apply_restore(dir.path(), &backup)
            .await
            .unwrap_err()
            .contains("movies"));
        assert!(!dir.path().join(RECOVERY).exists());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT id FROM movies")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            42
        );
    }

    #[test]
    fn relinks_windows_roots_without_matching_sibling_directories() {
        let target = if cfg!(windows) {
            "D:\\Media"
        } else {
            "/Volumes/Media"
        };
        let mappings = [FolderMapping {
            from: "C:\\Library\\TV".into(),
            to: target.into(),
        }];
        assert_eq!(
            remap_path("c:\\LIBRARY\\tv\\Show\\S01E01.mkv", &mappings),
            Some(
                Path::new(target)
                    .join("Show")
                    .join("S01E01.mkv")
                    .to_string_lossy()
                    .into_owned()
            )
        );
        assert_eq!(
            remap_path("C:\\Library\\TV Archive\\File.mkv", &mappings),
            None
        );
        assert_eq!(remap_path("C:\\Library\\TV\\..\\File.mkv", &mappings), None);
    }
}
