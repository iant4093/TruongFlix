//! API keys and passwords in the OS credential store (Windows Credential Manager).
//! All of them share one item (a JSON object).
use std::collections::BTreeMap;
use std::sync::Mutex;
use tauri::WebviewWindow;

const SERVICE: &str = "com.iantruong.truongflix";
const ACCOUNT: &str = "settings";

/// Settings that are kept in the keychain instead of the database. Backups leave them out too.
pub const KEYS: &[&str] = &[
    "tmdb_api_key",
    "omdb_api_key",
    "opensubtitles_api_key",
    "opensubtitles_username",
    "opensubtitles_password",
    "remote_code",
];

fn allowed(key: &str) -> Result<(), String> {
    if KEYS.contains(&key) {
        Ok(())
    } else {
        Err(format!("“{key}” is not a secret setting."))
    }
}

trait Store {
    fn read(&self) -> Result<Option<String>, String>;
    fn write(&self, value: &str) -> Result<(), String>;
    fn clear(&self) -> Result<(), String>;
}

struct Keychain;

impl Keychain {
    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
    }
}

// Ad-hoc signed Mac builds would trigger a Keychain access prompt after every update, so on macOS
// the keychain is skipped: reads find nothing and writes fail, and settings stay in the database.
#[cfg(target_os = "macos")]
impl Store for Keychain {
    fn read(&self) -> Result<Option<String>, String> {
        Ok(None)
    }

    fn write(&self, _value: &str) -> Result<(), String> {
        Err("The keychain isn't used on macOS.".into())
    }

    fn clear(&self) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
impl Store for Keychain {
    fn read(&self) -> Result<Option<String>, String> {
        match Self::entry()?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn write(&self, value: &str) -> Result<(), String> {
        Self::entry()?.set_password(value).map_err(|e| e.to_string())
    }

    fn clear(&self) -> Result<(), String> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

type Map = BTreeMap<String, String>;

struct Vault<S> {
    store: S,
    cache: Mutex<Option<Map>>,
}

impl<S: Store> Vault<S> {
    const fn new(store: S) -> Self {
        Self { store, cache: Mutex::new(None) }
    }

    fn parse(raw: Option<String>) -> Result<Map, String> {
        match raw {
            Some(raw) => serde_json::from_str(&raw).map_err(|_| "The keychain item is damaged.".to_string()),
            None => Ok(Map::new()),
        }
    }

    /// Runs `f` on the stored values (read from the keychain once, then cached).
    fn with<T>(&self, f: impl FnOnce(&S, &mut Option<Map>) -> Result<T, String>) -> Result<T, String> {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if cache.is_none() {
            *cache = Some(Self::parse(self.store.read()?)?);
        }
        f(&self.store, &mut *cache)
    }

    fn get(&self, key: &str) -> Result<Option<String>, String> {
        allowed(key)?;
        self.with(|_, cache| Ok(cache.as_ref().and_then(|m| m.get(key).cloned())))
    }

    fn put(&self, key: &str, value: Option<&str>) -> Result<(), String> {
        allowed(key)?;
        self.with(|store, cache| {
            let mut next = cache.clone().unwrap_or_default();
            match value {
                Some(value) => next.insert(key.to_owned(), value.to_owned()),
                None => next.remove(key),
            };
            if next.is_empty() {
                store.clear()?;
            } else {
                store.write(&serde_json::to_string(&next).map_err(|e| e.to_string())?)?;
            }
            // Only report success once the keychain gives the new values back.
            let saved = Self::parse(store.read()?)?;
            if saved != next {
                *cache = None;
                return Err("The keychain did not keep the new value.".into());
            }
            *cache = Some(next);
            Ok(())
        })
    }

    /// The secret settings with a value in the keychain.
    fn stored_keys(&self) -> Result<Vec<String>, String> {
        self.with(|_, cache| Ok(cache.as_ref().map(|m| m.keys().cloned().collect()).unwrap_or_default()))
    }
}

static VAULT: Vault<Keychain> = Vault::new(Keychain);

pub(crate) fn stored_keys() -> Result<Vec<String>, String> {
    VAULT.stored_keys()
}

fn main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Secrets are available in the main window only.".into())
    }
}

/// Keychain calls can block (macOS may show an access prompt), so they run off the IPC thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn secret_get(window: WebviewWindow, key: String) -> Result<Option<String>, String> {
    main_window(&window)?;
    allowed(&key)?;
    blocking(move || VAULT.get(&key)).await
}

#[tauri::command]
pub async fn secret_set(window: WebviewWindow, key: String, value: String) -> Result<(), String> {
    main_window(&window)?;
    allowed(&key)?;
    blocking(move || VAULT.put(&key, Some(&value))).await
}

#[tauri::command]
pub async fn secret_delete(window: WebviewWindow, key: String) -> Result<(), String> {
    main_window(&window)?;
    allowed(&key)?;
    blocking(move || VAULT.put(&key, None)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Memory {
        value: Mutex<Option<String>>,
        broken: bool,
    }

    impl Store for Memory {
        fn read(&self) -> Result<Option<String>, String> {
            if self.broken {
                return Err("no keychain".into());
            }
            Ok(self.value.lock().unwrap().clone())
        }
        fn write(&self, value: &str) -> Result<(), String> {
            if self.broken {
                return Err("no keychain".into());
            }
            *self.value.lock().unwrap() = Some(value.into());
            Ok(())
        }
        fn clear(&self) -> Result<(), String> {
            *self.value.lock().unwrap() = None;
            Ok(())
        }
    }

    #[test]
    fn only_secret_settings_are_allowed() {
        for key in KEYS {
            assert!(allowed(key).is_ok());
        }
        for key in ["media_directories", "active_profile", "", "TMDB_API_KEY", "tmdb_api_key ", "../tmdb_api_key"] {
            assert!(allowed(key).is_err(), "{key}");
        }
        let vault = Vault::new(Memory::default());
        assert!(vault.put("media_directories", Some("[]")).is_err());
        assert!(vault.get("vlc_executable_path").is_err());
        assert_eq!(*vault.store.value.lock().unwrap(), None);
    }

    #[test]
    fn stores_all_secrets_in_one_item() {
        let vault = Vault::new(Memory::default());
        assert_eq!(vault.get("tmdb_api_key").unwrap(), None);
        vault.put("tmdb_api_key", Some("abc")).unwrap();
        vault.put("remote_code", Some("123456")).unwrap();
        assert_eq!(vault.get("tmdb_api_key").unwrap().as_deref(), Some("abc"));
        assert_eq!(vault.stored_keys().unwrap(), ["remote_code", "tmdb_api_key"]);
        // A fresh process reads the same item back.
        let raw = vault.store.value.lock().unwrap().clone();
        let reopened = Vault::new(Memory { value: Mutex::new(raw), broken: false });
        assert_eq!(reopened.get("remote_code").unwrap().as_deref(), Some("123456"));
        vault.put("tmdb_api_key", None).unwrap();
        vault.put("remote_code", None).unwrap();
        assert_eq!(*vault.store.value.lock().unwrap(), None);
    }

    #[test]
    fn reports_an_unavailable_keychain() {
        let vault = Vault::new(Memory { broken: true, ..Default::default() });
        assert!(vault.get("tmdb_api_key").is_err());
        assert!(vault.put("tmdb_api_key", Some("abc")).is_err());
    }

    /// Touches the real OS keychain: `cargo test -- --ignored real_keychain`.
    #[test]
    #[ignore]
    fn real_keychain_round_trip() {
        struct Test;
        impl Store for Test {
            fn read(&self) -> Result<Option<String>, String> {
                match keyring::Entry::new(SERVICE, "test").map_err(|e| e.to_string())?.get_password() {
                    Ok(v) => Ok(Some(v)),
                    Err(keyring::Error::NoEntry) => Ok(None),
                    Err(e) => Err(e.to_string()),
                }
            }
            fn write(&self, value: &str) -> Result<(), String> {
                keyring::Entry::new(SERVICE, "test").map_err(|e| e.to_string())?.set_password(value).map_err(|e| e.to_string())
            }
            fn clear(&self) -> Result<(), String> {
                match keyring::Entry::new(SERVICE, "test").map_err(|e| e.to_string())?.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                    Err(e) => Err(e.to_string()),
                }
            }
        }
        let vault = Vault::new(Test);
        vault.put("omdb_api_key", Some("round-trip")).unwrap();
        assert_eq!(Vault::new(Test).get("omdb_api_key").unwrap().as_deref(), Some("round-trip"));
        vault.put("omdb_api_key", None).unwrap();
        assert_eq!(Test.read().unwrap(), None);
    }
}
