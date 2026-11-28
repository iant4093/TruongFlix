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
        CREATE TABLE movies(id INTEGER PRIMARY KEY, file_path TEXT UNIQUE NOT NULL);
        INSERT INTO movies VALUES (42, '/old/Movies/Favorites/Film.mkv');
        CREATE TABLE tv_series(id INTEGER PRIMARY KEY, folder_path TEXT);
        CREATE TABLE episodes(id INTEGER PRIMARY KEY, file_path TEXT);
        CREATE TABLE subtitles(id INTEGER PRIMARY KEY, file_path TEXT);
        CREATE TABLE torrents(save_path TEXT, source TEXT, file_paths TEXT);
        CREATE TABLE trash(entry_dir TEXT, items TEXT, snapshot TEXT);
        CREATE TABLE rename_batches(moves TEXT, roots TEXT);
        CREATE TABLE library_folders(path TEXT PRIMARY KEY, folder_id TEXT NOT NULL, seen_at INTEGER NOT NULL);
        INSERT INTO library_folders VALUES ('/old/movies', 'folder-1', 1);
        CREATE TABLE missing_media(file_path TEXT PRIMARY KEY, file_size INTEGER, removed_at INTEGER NOT NULL, snapshot TEXT NOT NULL);
        INSERT INTO missing_media VALUES ('/old/Movies/Gone.mkv', 1, 1, '{}');
        CREATE TABLE music_missing(file_path TEXT PRIMARY KEY, file_size INTEGER, removed_at INTEGER NOT NULL, state TEXT NOT NULL);
        INSERT INTO music_missing VALUES ('/old/Music/Gone.flac', 1, 1, '{}');
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

fn no_extras() -> Extras {
    Extras::default()
}

#[tokio::test]
async fn restores_a_live_snapshot_with_relinked_paths_and_preserves_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    let mut db = fixture(path).await;
    let file = path.join("saved.truongflix-backup");
    snapshot(&path.join(DB), &file, &no_extras()).await.unwrap();
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
    apply_restore(path, &path.join(PENDING), &[], None).await.unwrap();
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
    snapshot(&path.join(DB), &file, &no_extras()).await.unwrap();
    let mut saved = connect(&file, true, true).await.unwrap();
    let keys: Vec<String> = sqlx::query_scalar("SELECT key FROM settings ORDER BY key").fetch_all(&mut saved).await.unwrap();
    assert_eq!(keys, ["media_directories", "subtitle_language"]);
    assert!(!inspect(&mut saved).await.unwrap().secrets);
    saved.close().await.unwrap();

    sqlx::raw_sql("UPDATE settings SET value = 'new-key' WHERE key = 'tmdb_api_key'; UPDATE settings SET value = 'de' WHERE key = 'subtitle_language';")
        .execute(&mut db)
        .await
        .unwrap();
    db.close().await.unwrap();
    stage(path, &file, Vec::new()).await.unwrap();
    apply_restore(path, &path.join(PENDING), &[], None).await.unwrap();
    let mut restored = connect(&path.join(DB), true, false).await.unwrap();
    let settings: Vec<(String, String)> = sqlx::query_as("SELECT key, value FROM settings ORDER BY key").fetch_all(&mut restored).await.unwrap();
    let get = |k: &str| settings.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
    assert_eq!(get("tmdb_api_key"), Some("new-key"));
    assert_eq!(get("remote_code"), Some("123456"));
    assert_eq!(get("subtitle_language"), Some("fr"));
}

#[tokio::test]
async fn old_backups_do_not_override_keychain_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    let db = fixture(path).await;
    db.close().await.unwrap();
    let file = path.join("old.truongflix-backup");
    snapshot(&path.join(DB), &file, &no_extras()).await.unwrap();
    // Backups made before secrets were excluded still contain them.
    let mut old = connect(&file, false, false).await.unwrap();
    sqlx::raw_sql("INSERT INTO settings VALUES ('tmdb_api_key', 'stale-key'), ('omdb_api_key', 'omdb-from-backup');")
        .execute(&mut old)
        .await
        .unwrap();
    old.close().await.unwrap();

    stage(path, &file, Vec::new()).await.unwrap();
    apply_restore(path, &path.join(PENDING), &["tmdb_api_key".to_string()], None).await.unwrap();
    let mut restored = connect(&path.join(DB), true, false).await.unwrap();
    let keys: Vec<(String, String)> = sqlx::query_as("SELECT key, value FROM settings WHERE key LIKE '%api_key' ORDER BY key")
        .fetch_all(&mut restored)
        .await
        .unwrap();
    assert_eq!(keys, [("omdb_api_key".to_string(), "omdb-from-backup".to_string())]);
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
    snapshot(&dir.path().join(DB), &backup, &no_extras()).await.unwrap();
    let mut damaged = connect(&backup, false, false).await.unwrap();
    sqlx::raw_sql("DROP TABLE movies; CREATE TABLE movies(id INTEGER PRIMARY KEY)")
        .execute(&mut damaged)
        .await
        .unwrap();
    damaged.close().await.unwrap();
    assert!(apply_restore(dir.path(), &backup, &[], None)
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

#[tokio::test]
async fn restores_a_backup_made_before_a_column_was_added() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = fixture(dir.path()).await;
    let backup = dir.path().join(PENDING);
    snapshot(&dir.path().join(DB), &backup, &no_extras()).await.unwrap();
    // This computer has since gained a column the backup doesn't have.
    sqlx::raw_sql("ALTER TABLE movies ADD COLUMN stinger TEXT").execute(&mut db).await.unwrap();
    db.close().await.unwrap();
    apply_restore(dir.path(), &backup, &[], None).await.unwrap();
    let mut db = connect(&dir.path().join(DB), false, false).await.unwrap();
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT id FROM movies").fetch_one(&mut db).await.unwrap(), 42);
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

// ---------------------------------------------------------------------------
// Whole setups, driven by the manifest: a setting or table added to it is covered here without
// touching these tests (and tests/backup.test.ts fails for one that isn't in it).
// ---------------------------------------------------------------------------

/// Every setting key with its kind.
fn every_setting() -> Vec<(&'static str, &'static str)> {
    let s = &manifest().settings;
    let mut out = Vec::new();
    for (kind, keys) in [
        ("plain", &s.plain),
        ("file", &s.file),
        ("folders", &s.folders),
        ("folder", &s.folder),
        ("shares", &s.shares),
        ("secret", &s.secret),
        ("account", &s.account),
    ] {
        out.extend(keys.iter().map(|key| (kind, key.as_str())));
    }
    out
}

/// A value for `key` that's different on each computer (`tag`).
fn value(kind: &str, key: &str, tag: &str) -> String {
    match kind {
        "folders" => serde_json::json!([format!("/{tag}/{key}"), format!("/{tag}/{key}-2")]).to_string(),
        "folder" => format!("/{tag}/{key}"),
        "file" => format!("/{tag}/{key}/app.exe"),
        "shares" => serde_json::json!({ format!("/{tag}/nas"): { "mount_point": format!("/{tag}/nas"), "url": "smb://nas/media", "host": "nas", "kind": "smb", "mac": null } }).to_string(),
        "account" => (tag == "a").to_string(),
        _ => format!("{key}-{tag}"),
    }
}

const ART: &str = "0123456789abcdef0123456789abcdef.jpg";
const SONG_ART: &str = "fedcba9876543210fedcba9876543210.png";

/// A database with every table in the manifest. `tag`: whose data fills it (`None`: empty, as on
/// a computer TruongFlix was just installed on).
async fn full_fixture(dir: &Path, tag: Option<&str>) -> SqliteConnection {
    let file = dir.join(DB);
    fs::File::create(&file).unwrap();
    let mut db = connect(&file, false, false).await.unwrap();
    sqlx::raw_sql("
        PRAGMA journal_mode = WAL;
        CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE profiles(id INTEGER PRIMARY KEY, name TEXT NOT NULL, pin TEXT);
        CREATE TABLE movies(id INTEGER PRIMARY KEY, file_path TEXT UNIQUE NOT NULL);
        CREATE TABLE tv_series(id INTEGER PRIMARY KEY, folder_path TEXT);
        CREATE TABLE episodes(id INTEGER PRIMARY KEY, file_path TEXT);
        CREATE TABLE subtitles(id INTEGER PRIMARY KEY, file_path TEXT);
        CREATE TABLE profile_state(profile_id INTEGER, media_id INTEGER, progress_seconds INTEGER);
        CREATE TABLE music_tracks(id INTEGER PRIMARY KEY, file_path TEXT UNIQUE NOT NULL, file_mtime INTEGER NOT NULL, art TEXT);
        CREATE TABLE music_playlists(id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT, cover TEXT, import_cover TEXT);
        CREATE TABLE music_playlist_tracks(playlist_id INTEGER NOT NULL, position INTEGER NOT NULL, track_id INTEGER NOT NULL, PRIMARY KEY (playlist_id, position));
        CREATE TABLE games_library(id INTEGER PRIMARY KEY, slug TEXT NOT NULL, installer_dir TEXT, install_dir TEXT, exe_path TEXT);
        CREATE TABLE torrents(save_path TEXT, source TEXT, file_paths TEXT);
        CREATE TABLE trash(entry_dir TEXT, items TEXT, snapshot TEXT);
        CREATE TABLE rename_batches(moves TEXT, roots TEXT);
    ").execute(&mut db).await.unwrap();
    // The rest of the manifest's tables, whatever they hold (the ones that stay on this computer
    // too, so the test sees they do).
    for table in portable_tables().into_iter().chain(manifest().tables.local.iter().map(String::as_str)) {
        if !has_table(&mut db, "main", table).await.unwrap() {
            sqlx::query(&format!("CREATE TABLE {table}(id INTEGER PRIMARY KEY, note TEXT)")).execute(&mut db).await.unwrap();
            if let Some(tag) = tag {
                sqlx::query(&format!("INSERT INTO {table} VALUES (1, '{table}-{tag}')")).execute(&mut db).await.unwrap();
            }
        }
    }
    let Some(tag) = tag else { return db };
    for (kind, key) in every_setting() {
        // Secrets are in the keychain, not the database.
        if kind != "secret" {
            sqlx::query("INSERT INTO settings VALUES (?, ?)").bind(key).bind(value(kind, key, tag)).execute(&mut db).await.unwrap();
        }
    }
    sqlx::raw_sql(&format!("
        INSERT INTO profiles VALUES (1, 'Main {tag}', 'pin-hash'), (2, 'Kids {tag}', NULL);
        INSERT INTO movies VALUES (42, '/{tag}/media_directories/Film/Film.mkv');
        INSERT INTO tv_series VALUES (7, '/{tag}/media_directories/Show');
        INSERT INTO episodes VALUES (70, '/{tag}/media_directories/Show/S01E01.mkv');
        INSERT INTO subtitles VALUES (5, '/{tag}/media_directories/Film/Film.en.srt');
        INSERT INTO profile_state VALUES (1, 42, 312), (2, 70, 60);
        INSERT INTO music_tracks VALUES (9, '/{tag}/music_directories/Album/01.flac', 1700000000, '{SONG_ART}');
        INSERT INTO music_playlists VALUES (3, 1, 'Road trip {tag}', 'Songs for the car', '{ART}', NULL);
        INSERT INTO music_playlist_tracks VALUES (3, 0, 9);
        INSERT INTO games_library VALUES (4, 'game', '/{tag}/games_download_dir/game', '/{tag}/games_install_dir/Game', '/{tag}/games_install_dir/Game/game.exe');
        INSERT INTO torrents VALUES ('/{tag}/torrents', 'magnet:', '[]');
        INSERT INTO trash VALUES ('/{tag}/trash', '[]', '{{}}');
        INSERT INTO rename_batches VALUES ('[]', '[]');
    ")).execute(&mut db).await.unwrap();
    db
}

fn keychain(tag: &str) -> BTreeMap<String, String> {
    every_setting().into_iter().filter(|(kind, _)| *kind == "secret").map(|(kind, key)| (key.to_string(), value(kind, key, tag))).collect()
}

async fn settings_of(db: &mut SqliteConnection) -> BTreeMap<String, String> {
    sqlx::query_as::<_, (String, String)>("SELECT key, value FROM settings").fetch_all(db).await.unwrap().into_iter().collect()
}

/// A table's rows, in a form that compares.
async fn dump(db: &mut SqliteConnection, table: &str) -> String {
    let cols = columns(db, table).await.unwrap();
    let row = cols.iter().map(|c| format!("quote(\"{c}\")")).collect::<Vec<_>>().join(" || ',' || ");
    sqlx::query_scalar::<_, Option<String>>(&format!("SELECT group_concat(r, ' | ') FROM (SELECT {row} AS r FROM {table} ORDER BY rowid)"))
        .fetch_one(db)
        .await
        .unwrap()
        .unwrap_or_default()
}

fn local_storage(tag: &str) -> BTreeMap<String, String> {
    let mut out: BTreeMap<String, String> = manifest().local_storage.carry.iter().map(|key| (key.clone(), format!("{key}-{tag}"))).collect();
    out.insert("tf-pin-lockouts".into(), "{}".into()); // stays on its computer
    out
}

struct Computer {
    dir: tempfile::TempDir,
    art: PathBuf,
}

impl Computer {
    async fn new(tag: Option<&str>) -> (Self, SqliteConnection) {
        let dir = tempfile::tempdir().unwrap();
        let art = dir.path().join("cache").join(ART_FOLDER);
        fs::create_dir_all(&art).unwrap();
        let db = full_fixture(dir.path(), tag).await;
        (Self { dir, art }, db)
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }

    async fn restore(&self, file: &Path, mappings: Vec<FolderMapping>, keychain: &[String]) -> Result<Restored, String> {
        stage(self.path(), file, mappings).await?;
        apply_restore(self.path(), &self.path().join(PENDING), keychain, Some(&self.art)).await
    }

    async fn db(&self) -> SqliteConnection {
        connect(&self.path().join(DB), true, false).await.unwrap()
    }
}

#[test]
fn manifest_secrets_are_the_keychain_settings_and_no_key_has_two_kinds() {
    let mut secret = manifest().settings.secret.clone();
    secret.sort();
    let mut keys: Vec<String> = crate::secrets::KEYS.iter().map(|k| k.to_string()).collect();
    keys.sort();
    assert_eq!(secret, keys);
    let mut seen = HashSet::new();
    for (_, key) in every_setting() {
        assert!(seen.insert(key), "{key} is listed twice in the backup manifest");
    }
    let mut tables = HashSet::new();
    for table in portable_tables().into_iter().chain(manifest().tables.local.iter().map(String::as_str)) {
        assert!(tables.insert(table), "{table} is listed twice in the backup manifest");
    }
}

#[tokio::test]
async fn a_whole_setup_moves_to_a_new_computer_with_passwords_and_keys() {
    let (old, mut db) = Computer::new(Some("a")).await;
    fs::write(old.art.join(ART), b"playlist cover").unwrap();
    fs::write(old.art.join(SONG_ART), b"song cover").unwrap();
    let before = settings_of(&mut db).await;
    let mut tables = BTreeMap::new();
    for table in portable_tables() {
        tables.insert(table, dump(&mut db, table).await);
    }
    db.close().await.unwrap();
    let file = old.path().join("Setup.truongflix-backup");
    let extras = Extras { secrets: Some(keychain("a")), local: local_storage("a"), art_dir: Some(old.art.clone()) };
    snapshot(&old.path().join(DB), &file, &extras).await.unwrap();

    // A computer TruongFlix was just installed on: nothing set up, an empty keychain.
    let (new, db) = Computer::new(None).await;
    db.close().await.unwrap();
    let restored = new.restore(&file, Vec::new(), &[]).await.unwrap();
    let mut db = new.db().await;

    let after = settings_of(&mut db).await;
    for (kind, key) in every_setting() {
        let expected = if kind == "secret" { keychain("a")[key].clone() } else { before[key].clone() };
        assert_eq!(after.get(key), Some(&expected), "setting {key} ({kind}) didn't come back");
    }
    assert_eq!(after.len(), every_setting().len(), "only the setup's own settings: {after:?}");
    for table in portable_tables() {
        if table == "settings" || table == "music_tracks" {
            continue;
        }
        assert_eq!(dump(&mut db, table).await, tables[table], "table {table} didn't come back");
    }
    for table in &manifest().tables.local {
        assert_eq!(dump(&mut db, table).await, "", "{table} stays on the old computer");
    }
    // Playlist covers came along; songs whose cover didn't are read again at the next scan.
    assert_eq!(fs::read(new.art.join(ART)).unwrap(), b"playlist cover");
    let song: (Option<String>, i64) = sqlx::query_as("SELECT art, file_mtime FROM music_tracks WHERE id = 9").fetch_one(&mut db).await.unwrap();
    assert_eq!(song, (None, 0));
    // Window-storage preferences come back to the UI; local-only ones don't travel.
    let mut carried = local_storage("a");
    carried.remove("tf-pin-lockouts");
    assert_eq!(restored.local, carried);
    // Folders that aren't on this computer are kept and listed (network-share folders reconnect).
    let mut missing = restored.missing.clone();
    missing.sort();
    let mut expected: Vec<String> = every_setting()
        .into_iter()
        .filter(|(kind, _)| *kind == "folders" || *kind == "folder")
        .flat_map(|(kind, key)| match kind {
            "folders" => vec![format!("/a/{key}"), format!("/a/{key}-2")],
            _ => vec![format!("/a/{key}")],
        })
        .collect();
    expected.sort();
    assert_eq!(missing, expected);
}

#[tokio::test]
async fn without_passwords_and_keys_a_restore_keeps_this_computers_account() {
    let (old, db) = Computer::new(Some("a")).await;
    db.close().await.unwrap();
    let file = old.path().join("Setup.truongflix-backup");
    snapshot(&old.path().join(DB), &file, &Extras { local: local_storage("a"), ..Default::default() }).await.unwrap();
    let mut saved = connect(&file, true, true).await.unwrap();
    let info = inspect(&mut saved).await.unwrap();
    assert!(!info.secrets);
    assert_eq!(info.version, VERSION);
    let saved_keys = settings_of(&mut saved).await;
    for key in crate::secrets::KEYS {
        assert!(!saved_keys.contains_key(*key), "{key} is in a backup made without passwords and keys");
    }
    saved.close().await.unwrap();

    // The other computer has its own setup, with its own keys in the keychain and a Soulseek
    // account typed in (not made up).
    let (other, mut db) = Computer::new(Some("b")).await;
    let mine = settings_of(&mut db).await;
    db.close().await.unwrap();
    let relinked = other.path().join("Movies");
    fs::create_dir(&relinked).unwrap();
    let keychain: Vec<String> = crate::secrets::KEYS.iter().map(|k| k.to_string()).collect();
    let restored = other
        .restore(&file, vec![FolderMapping { from: "/a/media_directories".into(), to: relinked.to_string_lossy().into_owned() }], &keychain)
        .await
        .unwrap();
    let mut db = other.db().await;
    let after = settings_of(&mut db).await;
    let theirs = settings_of(&mut connect(&file, true, true).await.unwrap()).await;
    for (kind, key) in every_setting() {
        match kind {
            "secret" => assert_eq!(after.get(key), None, "{key} stays in this computer's keychain"),
            "account" => assert_eq!(after.get(key), mine.get(key), "{key} belongs with this computer's account"),
            "folders" if key == "media_directories" => {
                let folders: Vec<String> = serde_json::from_str(&after[key]).unwrap();
                assert_eq!(folders, [relinked.to_string_lossy().into_owned(), "/a/media_directories-2".to_string()]);
            }
            _ => assert_eq!(after.get(key), theirs.get(key), "setting {key} ({kind}) didn't come back"),
        }
    }
    let film: String = sqlx::query_scalar("SELECT file_path FROM movies").fetch_one(&mut db).await.unwrap();
    assert_eq!(film, relinked.join("Film").join("Film.mkv").to_string_lossy());
    assert!(!restored.missing.contains(&relinked.to_string_lossy().into_owned()));
    assert!(restored.missing.contains(&"/a/media_directories-2".to_string()));
}

#[tokio::test]
async fn restores_a_version_1_backup() {
    let (old, db) = Computer::new(Some("a")).await;
    db.close().await.unwrap();
    let file = old.path().join("Old.truongflix-backup");
    snapshot(&old.path().join(DB), &file, &no_extras()).await.unwrap();
    // What version 1 wrote: the tables only.
    let mut v1 = connect(&file, false, false).await.unwrap();
    sqlx::raw_sql("DROP TABLE backup_meta; DROP TABLE backup_local; DROP TABLE backup_files; PRAGMA user_version = 1;")
        .execute(&mut v1)
        .await
        .unwrap();
    v1.close().await.unwrap();

    let (other, db) = Computer::new(None).await;
    db.close().await.unwrap();
    let restored = other.restore(&file, Vec::new(), &[]).await.unwrap();
    assert!(restored.local.is_empty());
    let mut db = other.db().await;
    assert_eq!(settings_of(&mut db).await.get("subtitle_language").map(String::as_str), Some("subtitle_language-a"));
    assert_eq!(sqlx::query_scalar::<_, String>("SELECT name FROM music_playlists").fetch_one(&mut db).await.unwrap(), "Road trip a");
}

#[tokio::test]
async fn restores_a_partial_backup_and_ignores_what_it_doesnt_know() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    // An early setup: a few settings, no Music or Games, a column this version dropped and a
    // table it never had.
    let mut db = fixture(path).await;
    sqlx::raw_sql("
        INSERT INTO settings VALUES ('subtitle_language', 'fr'), ('some_future_setting', 'x');
        ALTER TABLE profiles ADD COLUMN mood TEXT;
        CREATE TABLE future_feature(id INTEGER PRIMARY KEY);
    ").execute(&mut db).await.unwrap();
    db.close().await.unwrap();
    let file = path.join("Partial.truongflix-backup");
    snapshot(&path.join(DB), &file, &no_extras()).await.unwrap();

    let (other, mut db) = Computer::new(Some("b")).await;
    let playlists = dump(&mut db, "music_playlists").await;
    db.close().await.unwrap();
    other.restore(&file, Vec::new(), &[]).await.unwrap();
    let mut db = other.db().await;
    let after = settings_of(&mut db).await;
    assert_eq!(after.get("subtitle_language").map(String::as_str), Some("fr"));
    // Settings the backup doesn't have take their defaults (no row).
    assert_eq!(after.get("music_directories"), None);
    assert_eq!(sqlx::query_scalar::<_, String>("SELECT name FROM profiles").fetch_one(&mut db).await.unwrap(), "Saved profile");
    // Tables the backup doesn't have stay as they are here.
    assert_eq!(dump(&mut db, "music_playlists").await, playlists);
    assert!(!has_table(&mut db, "main", "future_feature").await.unwrap());
}

#[tokio::test]
async fn refuses_a_backup_from_a_newer_version_without_staging_it() {
    let (old, db) = Computer::new(Some("a")).await;
    db.close().await.unwrap();
    let file = old.path().join("Newer.truongflix-backup");
    snapshot(&old.path().join(DB), &file, &no_extras()).await.unwrap();
    let mut newer = connect(&file, false, false).await.unwrap();
    sqlx::query(&format!("PRAGMA user_version = {}", VERSION + 1)).execute(&mut newer).await.unwrap();
    newer.close().await.unwrap();
    let (other, db) = Computer::new(Some("b")).await;
    db.close().await.unwrap();
    assert!(other.restore(&file, Vec::new(), &[]).await.unwrap_err().contains("newer"));
    assert!(!other.path().join(PENDING).exists());
}

#[tokio::test]
async fn a_restore_that_fails_part_way_changes_nothing() {
    let (old, db) = Computer::new(Some("a")).await;
    db.close().await.unwrap();
    let file = old.path().join("Setup.truongflix-backup");
    snapshot(&old.path().join(DB), &file, &no_extras()).await.unwrap();

    let (other, mut db) = Computer::new(Some("b")).await;
    // This computer refuses one of the backup's rows, after settings and profiles were replaced.
    sqlx::raw_sql("
        CREATE TABLE strict_movies(id INTEGER PRIMARY KEY, file_path TEXT UNIQUE NOT NULL CHECK (file_path NOT LIKE '/a/%'));
        INSERT INTO strict_movies SELECT * FROM movies;
        DROP TABLE movies;
        ALTER TABLE strict_movies RENAME TO movies;
    ").execute(&mut db).await.unwrap();
    let before = settings_of(&mut db).await;
    let mut tables = BTreeMap::new();
    for table in portable_tables() {
        tables.insert(table, dump(&mut db, table).await);
    }
    db.close().await.unwrap();
    assert!(other.restore(&file, Vec::new(), &[]).await.unwrap_err().contains("movies"));
    let mut db = other.db().await;
    assert_eq!(settings_of(&mut db).await, before);
    for table in portable_tables() {
        assert_eq!(dump(&mut db, table).await, tables[table], "{table} changed");
    }
}

/// The games play history table as the app makes it (src/games/library.ts).
const GAME_SESSIONS: &str = "CREATE TABLE games_play_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id INTEGER, slug TEXT NOT NULL,
    title TEXT NOT NULL, cover TEXT, started_at TEXT NOT NULL, seconds INTEGER NOT NULL, estimated INTEGER NOT NULL DEFAULT 0,
    profile_id INTEGER, game_key TEXT)";

async fn replace_game_sessions(db: &mut SqliteConnection, schema: &str, rows: &str) {
    sqlx::raw_sql(&format!("DROP TABLE games_play_sessions; {schema}; {rows}")).execute(db).await.unwrap();
}

#[tokio::test]
async fn game_play_stats_move_to_a_new_computer() {
    let (old, mut db) = Computer::new(Some("a")).await;
    replace_game_sessions(&mut db, GAME_SESSIONS, "
        INSERT INTO games_play_sessions (game_id, slug, title, cover, started_at, seconds, estimated, profile_id, game_key) VALUES
            (4, 'trees-v1', 'Trees', NULL, '2026-11-01T10:00:00.000Z', 3600, 0, 1, 'trees'),
            (NULL, 'rocks', 'Rocks', 'c.jpg', '2026-01-01T00:00:00.000Z', 700, 1, NULL, 'rocks');
    ").await;
    // Uninstalled games keep their history: a session whose game left the library comes along too.
    let before = dump(&mut db, "games_play_sessions").await;
    assert!(before.contains("'rocks'"));
    db.close().await.unwrap();
    let file = old.path().join("Setup.truongflix-backup");
    snapshot(&old.path().join(DB), &file, &no_extras()).await.unwrap();

    let (new, mut db) = Computer::new(None).await;
    replace_game_sessions(&mut db, GAME_SESSIONS, "").await;
    db.close().await.unwrap();
    new.restore(&file, Vec::new(), &[]).await.unwrap();
    let mut db = new.db().await;
    assert_eq!(dump(&mut db, "games_play_sessions").await, before);
}

#[tokio::test]
async fn game_play_stats_come_back_from_a_backup_made_before_sessions_noted_the_game() {
    let (old, mut db) = Computer::new(Some("a")).await;
    replace_game_sessions(&mut db, "CREATE TABLE games_play_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id INTEGER,
        slug TEXT NOT NULL, title TEXT NOT NULL, cover TEXT, started_at TEXT NOT NULL, seconds INTEGER NOT NULL, estimated INTEGER NOT NULL DEFAULT 0)", "
        INSERT INTO games_play_sessions (game_id, slug, title, started_at, seconds) VALUES (4, 'trees', 'Trees', '2026-11-01T10:00:00.000Z', 3600);
    ").await;
    db.close().await.unwrap();
    let file = old.path().join("Old.truongflix-backup");
    snapshot(&old.path().join(DB), &file, &no_extras()).await.unwrap();

    let (new, mut db) = Computer::new(None).await;
    replace_game_sessions(&mut db, GAME_SESSIONS, "").await;
    db.close().await.unwrap();
    new.restore(&file, Vec::new(), &[]).await.unwrap();
    let mut db = new.db().await;
    // The app keys these sessions on its next start (migrateGamesDb).
    assert_eq!(
        dump(&mut db, "games_play_sessions").await,
        "1,4,'trees','Trees',NULL,'2026-11-01T10:00:00.000Z',3600,0,NULL,NULL"
    );
}
