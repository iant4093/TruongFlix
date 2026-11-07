//! Checks installed files against the MD5 list repacks ship for their after-install integrity check.

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use md5::{Digest, Md5};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub hash: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VerifyProgress {
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub files_done: usize,
    pub files_total: usize,
    pub current: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResult {
    pub available: bool,
    pub files_checked: usize,
    pub mismatched: Vec<String>,
    pub missing: Vec<String>,
}

/// Finds the checksum list: `{app}\_Redist\*.md5` in current repacks, or `*.md5` in the game folder.
pub fn find_checksum_list(install_dir: &Path) -> Option<PathBuf> {
    let candidates = [install_dir.join("_Redist"), install_dir.join("MD5"), install_dir.to_path_buf()];
    candidates.iter().find_map(|dir| {
        let mut lists: Vec<PathBuf> = std::fs::read_dir(dir)
            .ok()?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.is_file() && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("md5")))
            .collect();
        lists.sort();
        lists.into_iter().next()
    })
}

/// Parses `hash *relative\path` lines (paths relative to the list's folder). Comment lines start with
/// `;`. Paths that would leave the game folder are ignored.
pub fn parse_checksum_list(text: &str, list_dir: &Path, install_dir: &Path) -> Vec<Entry> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim().trim_start_matches('\u{feff}');
            if line.is_empty() || line.starts_with(';') {
                return None;
            }
            let (hash, rest) = line.split_once(char::is_whitespace)?;
            if hash.len() != 32 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
                return None;
            }
            let relative = rest.trim().trim_start_matches('*').replace('/', "\\");
            let path = normalize(&list_dir.join(relative))?;
            path.starts_with(install_dir).then(|| Entry { hash: hash.to_ascii_lowercase(), path })
        })
        .collect()
}

fn normalize(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    Some(out)
}

fn md5_file(path: &Path, mut on_bytes: impl FnMut(u64)) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Md5::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        on_bytes(n as u64);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

pub fn verify(install_dir: &Path, mut on_progress: impl FnMut(&VerifyProgress)) -> VerifyResult {
    let unavailable = VerifyResult { available: false, files_checked: 0, mismatched: vec![], missing: vec![] };
    let Some(list) = find_checksum_list(install_dir) else {
        return unavailable;
    };
    let Ok(bytes) = std::fs::read(&list) else {
        return unavailable;
    };
    let list_dir = list.parent().unwrap_or(install_dir);
    let install_dir = normalize(install_dir).unwrap_or_else(|| install_dir.to_path_buf());
    let entries = parse_checksum_list(&String::from_utf8_lossy(&bytes), list_dir, &install_dir);
    if entries.is_empty() {
        return unavailable;
    }

    let display = |p: &Path| p.strip_prefix(&install_dir).unwrap_or(p).to_string_lossy().into_owned();
    let total_bytes = entries.iter().filter_map(|e| std::fs::metadata(&e.path).ok()).map(|m| m.len()).sum();
    let mut progress = VerifyProgress {
        done_bytes: 0,
        total_bytes,
        files_done: 0,
        files_total: entries.len(),
        current: String::new(),
    };
    let mut result = VerifyResult { available: true, files_checked: 0, mismatched: vec![], missing: vec![] };
    let mut last_report = Instant::now() - Duration::from_secs(1);
    on_progress(&progress);

    for entry in &entries {
        progress.current = display(&entry.path);
        if !entry.path.is_file() {
            result.missing.push(progress.current.clone());
        } else {
            let hashed = md5_file(&entry.path, |n| {
                progress.done_bytes += n;
                if last_report.elapsed() >= Duration::from_millis(200) {
                    last_report = Instant::now();
                    on_progress(&progress);
                }
            });
            match hashed {
                Ok(hash) if hash == entry.hash => {}
                _ => result.mismatched.push(progress.current.clone()),
            }
        }
        progress.files_done += 1;
        result.files_checked += 1;
    }
    on_progress(&progress);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_relative_entries_and_rejects_escapes() {
        let install = Path::new(r"D:\Games\Trees");
        let list_dir = install.join("_Redist");
        let text = "; comment\r\n\u{feff}1e0c8a7f2bb0e6c957a8d7d975a6d5df *..\\Game\\Binaries\\a.dll\r\n\
                    nothex *..\\x\r\n\
                    0123456789abcdef0123456789ABCDEF *..\\..\\outside.txt\r\n";
        let entries = parse_checksum_list(text, &list_dir, install);
        assert_eq!(
            entries,
            vec![Entry {
                hash: "1e0c8a7f2bb0e6c957a8d7d975a6d5df".into(),
                path: PathBuf::from(r"D:\Games\Trees\Game\Binaries\a.dll"),
            }]
        );
    }

    #[test]
    fn verifies_files_and_reports_mismatches() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("_Redist")).unwrap();
        std::fs::write(root.join("good.bin"), b"hello").unwrap();
        std::fs::write(root.join("bad.bin"), b"tampered").unwrap();
        std::fs::write(
            root.join("_Redist").join("checksums.md5"),
            "5d41402abc4b2a76b9719d911017c592 *..\\good.bin\n\
             5d41402abc4b2a76b9719d911017c592 *..\\bad.bin\n\
             5d41402abc4b2a76b9719d911017c592 *..\\gone.bin\n",
        )
        .unwrap();
        let mut last = None;
        let result = verify(root, |p| last = Some(p.clone()));
        assert!(result.available);
        assert_eq!(result.files_checked, 3);
        assert_eq!(result.mismatched, vec!["bad.bin".to_string()]);
        assert_eq!(result.missing, vec!["gone.bin".to_string()]);
        let last = last.unwrap();
        assert_eq!((last.files_done, last.files_total, last.done_bytes), (3, 3, 13));
    }

    /// Set `TRUONGFLIX_TEST_VERIFY_DIR` to an installed repack's folder to verify it for real.
    #[test]
    fn verifies_a_real_install_when_available() {
        let Ok(dir) = std::env::var("TRUONGFLIX_TEST_VERIFY_DIR") else {
            return;
        };
        let started = std::time::Instant::now();
        let result = verify(Path::new(&dir), |_| {});
        println!("{result:?} in {:?}", started.elapsed());
        assert!(result.available);
        assert!(result.mismatched.is_empty() && result.missing.is_empty());
    }

    #[test]
    fn reports_unavailable_without_a_list() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!verify(dir.path(), |_| {}).available);
    }
}
