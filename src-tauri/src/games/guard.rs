//! Checks every path and choice that an install, uninstall, launch or delete acts on. Install and
//! uninstall jobs are checked in the app before asking for administrator rights, and again by the
//! elevated helper, which trusts nothing it is handed.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

use windows_sys::core::GUID;
use windows_sys::Win32::UI::Shell::{
    FOLDERID_CommonPrograms, FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_LocalAppData,
    FOLDERID_Profile, FOLDERID_ProgramData, FOLDERID_ProgramFiles, FOLDERID_ProgramFilesX86, FOLDERID_Programs,
    FOLDERID_Public, FOLDERID_PublicDesktop, FOLDERID_RoamingAppData, FOLDERID_System, FOLDERID_SystemX86,
    FOLDERID_Windows,
};

use super::installer::InstallerInfo;

pub fn known_folder(id: &GUID) -> String {
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::SHGetKnownFolderPath;
    unsafe {
        let mut raw: windows_sys::core::PWSTR = std::ptr::null_mut();
        if SHGetKnownFolderPath(id, 0, std::ptr::null_mut(), &mut raw) != 0 || raw.is_null() {
            return String::new();
        }
        let len = (0..).take_while(|&i| *raw.add(i) != 0).count();
        let path = String::from_utf16_lossy(std::slice::from_raw_parts(raw, len));
        CoTaskMemFree(raw as _);
        path
    }
}

/// `path` without the `\\?\` prefix `canonicalize` adds, as other programs expect.
pub fn plain(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\UNC\") {
        Some(rest) => PathBuf::from(format!(r"\\{rest}")),
        None => PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text)),
    }
}

/// Lower-cased plain path, for comparisons.
pub fn key(path: &Path) -> PathBuf {
    PathBuf::from(plain(path).to_string_lossy().to_lowercase())
}

pub fn same(a: &Path, b: &Path) -> bool {
    key(a) == key(b)
}

/// `path` lies below `root` (and is not `root` itself).
pub fn strictly_inside(path: &Path, root: &Path) -> bool {
    let (path, root) = (key(path), key(root));
    path != root && path.starts_with(&root)
}

/// An absolute path without `.`/`..` parts, alternate data streams or wildcard characters.
pub fn clean_absolute(path: &Path) -> Result<PathBuf, String> {
    let bad_part = path.components().any(|c| match c {
        Component::ParentDir | Component::CurDir => true,
        Component::Normal(part) => part.to_string_lossy().contains([':', '"', '*', '?', '<', '>', '|']),
        _ => false,
    });
    if !path.is_absolute() || bad_part || path.to_string_lossy().contains(['"', '\0']) {
        return Err(format!("'{}' is not a valid folder.", path.display()));
    }
    Ok(path.to_path_buf())
}

/// Where `path` really is, following links: its nearest existing folder resolved, plus the rest
/// (the path itself may not exist yet).
pub fn resolve(path: &Path) -> Result<PathBuf, String> {
    let path = clean_absolute(path)?;
    let invalid = || format!("'{}' is not a valid folder.", path.display());
    let mut existing = path.as_path();
    let mut rest = Vec::new();
    loop {
        if let Ok(real) = std::fs::canonicalize(existing) {
            return Ok(rest.iter().rev().fold(real, |out, part| out.join(part)));
        }
        rest.push(existing.file_name().ok_or_else(invalid)?.to_os_string());
        existing = existing.parent().ok_or_else(invalid)?;
    }
}

/// System folders games must never be installed to, uninstalled from or deleted.
pub struct Protected {
    /// These folders and everything inside them.
    within: Vec<PathBuf>,
    /// These folders and every folder that contains them.
    core: Vec<PathBuf>,
    /// Like `core`, but allowed as a download folder (e.g. Downloads).
    personal: Vec<PathBuf>,
}

fn keys(paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut out = BTreeSet::new();
    for path in paths.into_iter().filter(|p| p.is_absolute()) {
        out.insert(key(&path));
        if let Ok(real) = std::fs::canonicalize(&path) {
            out.insert(key(&real));
        }
    }
    out.into_iter().collect()
}

impl Protected {
    pub fn new(within: Vec<PathBuf>, core: Vec<PathBuf>, personal: Vec<PathBuf>) -> Self {
        Protected { within: keys(within), core: keys(core), personal: keys(personal) }
    }

    pub fn system() -> Self {
        let folder = |id: &GUID| PathBuf::from(known_folder(id));
        Protected::new(
            vec![folder(&FOLDERID_Windows), folder(&FOLDERID_System), folder(&FOLDERID_SystemX86)],
            [
                &FOLDERID_ProgramFiles,
                &FOLDERID_ProgramFilesX86,
                &FOLDERID_ProgramData,
                &FOLDERID_Profile,
                &FOLDERID_Public,
                &FOLDERID_RoamingAppData,
                &FOLDERID_LocalAppData,
            ]
            .into_iter()
            .map(folder)
            .collect(),
            [&FOLDERID_Desktop, &FOLDERID_PublicDesktop, &FOLDERID_Documents, &FOLDERID_Downloads, &FOLDERID_Programs, &FOLDERID_CommonPrograms]
                .into_iter()
                .map(folder)
                .collect(),
        )
    }

    fn hits(&self, path: &Path, personal: bool) -> bool {
        let path = key(path);
        let holds = |list: &[PathBuf]| list.iter().any(|p| p.starts_with(&path));
        path.parent().is_none()
            || path.components().count() < 2
            || self.within.iter().any(|w| path.starts_with(w))
            || holds(&self.core)
            || (personal && holds(&self.personal))
    }

    /// Drive roots, Windows, Program Files, the user's profile and similar folders (or any folder
    /// containing one of them).
    pub fn covers(&self, path: &Path) -> bool {
        self.hits(path, true)
    }

    /// Like `covers`, but the user's own Downloads/Documents/Desktop may hold game downloads.
    pub fn covers_root(&self, path: &Path) -> bool {
        self.hits(path, false)
    }
}

/// The games download folder, resolved. It must exist and must not be a drive or system folder.
pub fn download_root(root: &Path, protected: &Protected) -> Result<PathBuf, String> {
    let message = "Choose a dedicated folder for game downloads in Settings › Games.";
    let root = clean_absolute(root).map_err(|_| message.to_string())?;
    let real = std::fs::canonicalize(&root).map_err(|_| message.to_string())?;
    if !real.is_dir() || protected.covers_root(&real) {
        return Err(message.into());
    }
    Ok(plain(&real))
}

/// A folder (or file) that must already exist strictly inside `root`, resolved through links.
pub fn existing_inside(path: &Path, root: &Path) -> Result<PathBuf, String> {
    let real = std::fs::canonicalize(clean_absolute(path)?).map_err(|e| format!("Couldn't find '{}': {e}", path.display()))?;
    if !strictly_inside(&real, root) {
        return Err(format!("'{}' is not inside the games download folder.", path.display()));
    }
    Ok(plain(&real))
}

/// A folder games may be installed to (it need not exist yet).
pub fn install_dir(path: &Path, protected: &Protected) -> Result<PathBuf, String> {
    let real = resolve(path)?;
    if protected.covers(&real) || real.is_file() {
        return Err(format!("Games can't be installed to '{}'. Choose another folder.", path.display()));
    }
    Ok(plain(&real))
}

fn is_uninstaller_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.len() == "unins000.exe".len()
        && name.starts_with("unins")
        && name.ends_with(".exe")
        && name[5..8].bytes().all(|b| b.is_ascii_digit())
}

/// An installed game's folder and its Inno uninstaller (`unins###.exe` with its `.dat`).
pub fn uninstall_target(dir: &Path, protected: &Protected) -> Result<(PathBuf, PathBuf), String> {
    let dir = std::fs::canonicalize(clean_absolute(dir)?).map_err(|_| "The game's folder is missing.".to_string())?;
    let dir = plain(&dir);
    if !dir.is_dir() || protected.covers(&dir) {
        return Err(format!("'{}' can't be uninstalled by TruongFlix.", dir.display()));
    }
    let mut found: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .map(|e| e.path())
        .filter(|p| p.file_name().is_some_and(|n| is_uninstaller_name(&n.to_string_lossy())))
        .filter(|p| p.with_extension("dat").is_file())
        .collect();
    found.sort();
    let uninstaller = found
        .pop()
        .ok_or_else(|| format!("No uninstaller was found in '{}'. Delete the folder yourself.", dir.display()))?;
    Ok((dir, uninstaller))
}

/// Desktop and Start Menu folders, where the shortcuts an installer creates live.
pub fn shortcut_roots() -> Vec<PathBuf> {
    [&FOLDERID_Desktop, &FOLDERID_PublicDesktop, &FOLDERID_Programs, &FOLDERID_CommonPrograms]
        .into_iter()
        .filter_map(|id| std::fs::canonicalize(known_folder(id)).ok())
        .collect()
}

/// A `.lnk` file inside a Desktop or Start Menu folder, resolved through links.
pub fn shortcut(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let invalid = || format!("'{}' is not a desktop or Start menu shortcut.", path.display());
    let is_lnk = |p: &Path| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("lnk"));
    let real = resolve(path).map_err(|_| invalid())?;
    if !is_lnk(path) || !is_lnk(&real) || !roots.iter().any(|r| strictly_inside(&real, r)) {
        return Err(invalid());
    }
    Ok(plain(&real))
}

fn is_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | '\\'))
        && !value.starts_with(['-', '\\', '.'])
}

fn pick(value: &str, allowed: &[&str], what: &str) -> Result<String, String> {
    let found = is_name(value).then(|| allowed.iter().find(|a| a.eq_ignore_ascii_case(value))).flatten();
    found.map(|a| a.to_string()).ok_or_else(|| format!("The installer has no {what} called '{value}'."))
}

/// The installer's own spelling of the chosen language.
pub fn language(value: &str, info: &InstallerInfo) -> Result<String, String> {
    let allowed: Vec<&str> = info.languages.iter().map(|l| l.name.as_str()).collect();
    pick(value, &allowed, "language")
}

pub fn components(values: &[String], info: &InstallerInfo) -> Result<Vec<String>, String> {
    let allowed: Vec<&str> = info.components.iter().map(|c| c.name.as_str()).collect();
    names(values, &allowed, "component")
}

pub fn tasks(values: &[String], info: &InstallerInfo) -> Result<Vec<String>, String> {
    let allowed: Vec<&str> = info.tasks.iter().map(|t| t.name.as_str()).collect();
    names(values, &allowed, "task")
}

fn names(values: &[String], allowed: &[&str], what: &str) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for value in values {
        let name = pick(value, allowed, what)?;
        if !out.iter().any(|n| n.eq_ignore_ascii_case(&name)) {
            out.push(name);
        }
    }
    Ok(out)
}

/// An after-install action from the installer's own `[Run]` section.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostAction {
    pub label: String,
    pub filename: PathBuf,
    pub parameters: String,
    pub working_dir: Option<PathBuf>,
}

/// Values for the Inno constants after-install actions may use. `{tmp}` is deliberately absent:
/// it is a user-writable folder, so nothing in it is run with administrator rights.
pub struct Constants(pub Vec<(&'static str, PathBuf)>);

impl Constants {
    pub fn new(app: &Path, src: &Path) -> Self {
        let folder = |id: &GUID| PathBuf::from(known_folder(id));
        let (pf, pf32) = (folder(&FOLDERID_ProgramFiles), folder(&FOLDERID_ProgramFilesX86));
        Constants(vec![
            ("app", app.to_path_buf()),
            ("src", src.to_path_buf()),
            ("win", folder(&FOLDERID_Windows)),
            ("sys", folder(&FOLDERID_System)),
            ("syswow64", folder(&FOLDERID_SystemX86)),
            ("pf", pf.clone()),
            ("commonpf", pf.clone()),
            ("pf64", pf.clone()),
            ("commonpf64", pf),
            ("pf32", pf32.clone()),
            ("commonpf32", pf32),
        ])
    }

    fn get(&self, name: &str) -> Option<&Path> {
        self.0.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_path())
    }

    fn sys(&self) -> Option<&Path> {
        self.get("sys").filter(|p| p.is_absolute())
    }

    /// Expands `{name}` constants; unknown ones (including `{tmp}`) are refused.
    pub fn expand(&self, text: &str) -> Result<String, String> {
        let mut out = String::new();
        let mut rest = text;
        while let Some(start) = rest.find('{') {
            out.push_str(&rest[..start]);
            rest = &rest[start + 1..];
            if let Some(after) = rest.strip_prefix('{') {
                out.push('{');
                rest = after;
                continue;
            }
            let end = rest.find('}').ok_or("Unfinished constant")?;
            let name = &rest[..end];
            let value = self
                .get(name)
                .filter(|v| v.is_absolute())
                .ok_or_else(|| format!("The constant {{{name}}} can't be used by TruongFlix"))?;
            out.push_str(&value.to_string_lossy());
            rest = &rest[end + 1..];
        }
        out.push_str(rest);
        Ok(out)
    }
}

fn languages_match(languages: Option<&str>, language: Option<&str>) -> bool {
    match (languages.map(str::trim).filter(|l| !l.is_empty()), language) {
        (Some(list), Some(lang)) => list.split_whitespace().any(|l| l.eq_ignore_ascii_case(lang)),
        _ => true,
    }
}

/// Picks after-install actions by their index in the installer's `[Run]` section, resolving
/// their program and parameters from the installer itself.
pub fn post_actions(
    indices: &[usize],
    info: &InstallerInfo,
    language: Option<&str>,
    constants: &Constants,
) -> Result<Vec<PostAction>, String> {
    let chosen: BTreeSet<usize> = indices.iter().copied().collect();
    chosen
        .into_iter()
        .map(|index| {
            let entry = info.run_entries.get(index).ok_or("Unknown after-install action")?;
            let fail = |why: String| format!("The after-install action '{}' can't be run: {why}", entry.description);
            let name = entry.filename.trim();
            if !entry.post_install || entry.shell_exec || name.contains("://") || !languages_match(entry.languages.as_deref(), language) {
                return Err(fail("it is not an installer action".into()));
            }
            let expanded = constants.expand(name).map_err(fail)?;
            let filename = if expanded.contains(['\\', '/', ':']) {
                clean_absolute(Path::new(&expanded)).map_err(fail)?
            } else {
                let sys = constants.sys().ok_or_else(|| fail("Windows folder not found".into()))?;
                Some(sys.join(&expanded)).filter(|p| p.is_file()).ok_or_else(|| fail(format!("{expanded} was not found")))?
            };
            if filename.extension().is_none_or(|e| !e.eq_ignore_ascii_case("exe") && !e.eq_ignore_ascii_case("msi")) {
                return Err(fail("only programs can be run".into()));
            }
            let parameters = constants.expand(&entry.parameters).map_err(fail)?;
            let working_dir = match &entry.working_dir {
                Some(dir) => Some(clean_absolute(Path::new(&constants.expand(dir).map_err(fail)?)).map_err(fail)?),
                None => None,
            };
            let description = entry.description.replace('&', "");
            let label = if description.trim().is_empty() || description.contains('{') {
                filename.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
            } else {
                description.trim().to_string()
            };
            Ok(PostAction { label, filename, parameters, working_dir })
        })
        .collect()
}

/// Inno's temporary folders: `%TEMP%\is-XXXXX.tmp`, real folders only (no links).
pub fn is_installer_temp_dir(dir: &Path, temp: &Path) -> bool {
    let name_ok = dir.file_name().is_some_and(|n| {
        let n = n.to_string_lossy().to_ascii_lowercase();
        n.len() > 7
            && n.len() <= 24
            && n.starts_with("is-")
            && n.ends_with(".tmp")
            && n[3..n.len() - 4].bytes().all(|b| b.is_ascii_alphanumeric())
    });
    name_ok
        && dir.parent().is_some_and(|p| same(p, temp))
        && std::fs::symlink_metadata(dir).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
}

#[cfg(test)]
mod tests {
    use super::super::installer::{LanguageInfo, RunInfo};
    use super::*;

    fn run(filename: &str, parameters: &str) -> RunInfo {
        RunInfo {
            filename: filename.into(),
            parameters: parameters.into(),
            working_dir: None,
            description: "Update DirectX".into(),
            post_install: true,
            unchecked: false,
            skip_if_silent: false,
            shell_exec: false,
            components: None,
            tasks: None,
            languages: None,
        }
    }

    fn info() -> InstallerInfo {
        InstallerInfo {
            setup_exe: String::new(),
            app_name: "Game".into(),
            default_dir_name: String::new(),
            extra_disk_space: 0,
            languages: vec![
                LanguageInfo { name: "en".into(), display: "English".into() },
                LanguageInfo { name: "russian".into(), display: "Русский".into() },
            ],
            types: vec![],
            components: vec![],
            tasks: vec![],
            run_entries: vec![
                run(r"{app}\_Redist\dxwebsetup.exe", ""),
                run("cmd.exe", r#"/c "{tmp}\host.cmd""#),
                run("http://site.example", ""),
                run(r"{app}\_Redist\vc_redist.x64.exe", "/q"),
                RunInfo { languages: Some("russian".into()), ..run(r"{app}\x.exe", "") },
                RunInfo { post_install: false, ..run(r"{app}\y.exe", "") },
                run(r"{app}\_Redist\{code:Evil}.exe", ""),
            ],
            icons: vec![],
            messages: vec![],
        }
    }

    #[test]
    fn containment_handles_dot_dot_case_and_verbatim_prefixes() {
        let root = Path::new(r"\\?\D:\Downloads\Games");
        assert!(strictly_inside(Path::new(r"d:\downloads\games\Tree"), root));
        assert!(!strictly_inside(Path::new(r"D:\Downloads\Games"), root));
        assert!(!strictly_inside(Path::new(r"D:\Downloads\GamesX\a"), root));
        assert!(clean_absolute(Path::new(r"D:\Downloads\Games\..\..\Windows")).is_err());
        assert!(clean_absolute(Path::new(r"Games\x")).is_err());
        assert!(clean_absolute(Path::new(r"D:\Games\x:stream")).is_err());
        assert!(clean_absolute(Path::new(r#"D:\Games\a" /evil"#)).is_err());
        assert!(clean_absolute(Path::new(r"D:\Games\Tree")).is_ok());
    }

    #[test]
    fn existing_paths_must_really_be_inside_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(root.join("game")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let real_root = std::fs::canonicalize(&root).unwrap();
        assert!(existing_inside(&root.join("game"), &real_root).is_ok());
        assert!(existing_inside(&root, &real_root).is_err());
        assert!(existing_inside(&root.join("missing"), &real_root).is_err());
        assert!(existing_inside(&outside, &real_root).is_err());

        // A junction inside the root that points outside it resolves to where it really goes.
        let link = root.join("link");
        let made = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .is_ok_and(|o| o.status.success());
        if made {
            assert!(existing_inside(&link, &real_root).is_err());
            assert!(!strictly_inside(&resolve(&link.join("new")).unwrap(), &real_root));
        }
    }

    #[test]
    fn resolves_folders_that_do_not_exist_yet() {
        let dir = tempfile::tempdir().unwrap();
        let real = std::fs::canonicalize(dir.path()).unwrap();
        assert_eq!(resolve(&dir.path().join("a").join("b")).unwrap(), real.join("a").join("b"));
    }

    #[test]
    fn protected_folders_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let windows = base.join("Windows");
        let profile = base.join("Users").join("me");
        let downloads = profile.join("Downloads");
        let protected = Protected::new(vec![windows.clone()], vec![profile.clone()], vec![downloads.clone()]);
        assert!(protected.covers(Path::new(r"C:\")));
        assert!(protected.covers(Path::new(r"\\?\D:\")));
        assert!(protected.covers(&windows));
        assert!(protected.covers(&windows.join("System32").join("x")));
        assert!(protected.covers(&profile));
        assert!(protected.covers(&base.join("Users")));
        assert!(protected.covers(&downloads));
        assert!(!protected.covers(&downloads.join("Game")));
        assert!(!protected.covers(&profile.join("Games").join("Tree")));
        assert!(!protected.covers(&base.join("Games")));
        assert!(!protected.covers_root(&downloads));
        assert!(protected.covers_root(&profile));

        let system = Protected::system();
        for id in [&FOLDERID_Windows, &FOLDERID_ProgramFiles, &FOLDERID_Profile, &FOLDERID_ProgramData, &FOLDERID_Desktop] {
            assert!(system.covers(Path::new(&known_folder(id))), "{}", known_folder(id));
        }
        assert!(system.covers(&PathBuf::from(known_folder(&FOLDERID_System)).join("drivers")));
        assert!(!system.covers(&PathBuf::from(known_folder(&FOLDERID_ProgramFiles)).join("Some Game")));
    }

    #[test]
    fn install_folders_cannot_be_system_folders() {
        let dir = tempfile::tempdir().unwrap();
        let system = Protected::system();
        assert!(install_dir(&dir.path().join("Game"), &system).is_ok());
        assert!(install_dir(Path::new(&known_folder(&FOLDERID_Windows)), &system).is_err());
        assert!(install_dir(Path::new(r"C:\"), &system).is_err());
        assert!(install_dir(&PathBuf::from(known_folder(&FOLDERID_Profile)), &system).is_err());
        assert!(install_dir(Path::new(r"relative\Game"), &system).is_err());
    }

    #[test]
    fn uninstall_needs_an_inno_uninstaller_and_a_normal_folder() {
        let dir = tempfile::tempdir().unwrap();
        let game = std::fs::canonicalize(dir.path()).unwrap().join("Game");
        std::fs::create_dir_all(&game).unwrap();
        let none = Protected::new(vec![], vec![], vec![]);
        assert!(uninstall_target(&game, &none).is_err());
        std::fs::write(game.join("unins000.exe"), b"").unwrap();
        assert!(uninstall_target(&game, &none).is_err(), "needs the .dat too");
        std::fs::write(game.join("unins000.dat"), b"").unwrap();
        std::fs::write(game.join("uninstall-helper.exe"), b"").unwrap();
        let (real, uninstaller) = uninstall_target(&game, &none).unwrap();
        assert_eq!(uninstaller, real.join("unins000.exe"));
        assert!(uninstall_target(&game, &Protected::new(vec![], vec![game.join("x")], vec![])).is_err());
        assert!(uninstall_target(Path::new(&known_folder(&FOLDERID_Windows)), &Protected::system()).is_err());
        assert!(uninstall_target(Path::new(r"C:\"), &Protected::system()).is_err());
        assert!(is_uninstaller_name("UNINS001.EXE"));
        assert!(!is_uninstaller_name("unins.exe"));
    }

    #[test]
    fn shortcuts_must_be_links_in_desktop_or_start_menu() {
        let dir = tempfile::tempdir().unwrap();
        let desktop = std::fs::canonicalize(dir.path()).unwrap().join("Desktop");
        let programs = desktop.with_file_name("Programs");
        std::fs::create_dir_all(&desktop).unwrap();
        std::fs::create_dir_all(programs.join("Group")).unwrap();
        let roots = vec![desktop.clone(), programs.clone()];
        assert!(shortcut(&desktop.join("Tree.lnk"), &roots).is_ok());
        assert!(shortcut(&programs.join("Group").join("Tree.LNK"), &roots).is_ok());
        assert!(shortcut(&desktop.join("Tree.exe"), &roots).is_err());
        assert!(shortcut(&desktop.join("..").join("x.lnk"), &roots).is_err());
        assert!(shortcut(&desktop, &roots).is_err());
        assert!(shortcut(&dir.path().join("x.lnk"), &roots).is_err());
        assert!(shortcut(Path::new("x.lnk"), &roots).is_err());
    }

    #[test]
    fn languages_components_and_tasks_must_come_from_the_installer() {
        let mut info = info();
        assert_eq!(language("EN", &info).unwrap(), "en");
        assert!(language("de", &info).is_err());
        assert!(language("en /DIR=C:\\", &info).is_err());
        assert!(language("\"en\"", &info).is_err());
        info.languages.push(LanguageInfo { name: "en\" /x".into(), display: String::new() });
        assert!(language("en\" /x", &info).is_err());

        let comp = |name: &str| super::super::installer::ComponentInfo {
            name: name.into(),
            description: String::new(),
            types: None,
            languages: None,
            level: 0,
            size: 0,
            fixed: false,
            exclusive: false,
            dont_inherit_check: false,
        };
        info.components = vec![comp("text"), comp("lang\\de")];
        assert_eq!(components(&["TEXT".into(), "lang\\de".into(), "text".into()], &info).unwrap(), vec!["text", "lang\\de"]);
        assert!(components(&["text,evil".into()], &info).is_err());
        assert!(components(&["!text".into()], &info).is_err());
        assert!(tasks(&["desktopicon".into()], &info).is_err());
        assert_eq!(tasks(&[], &info).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn post_actions_come_from_the_installer_run_entries() {
        let info = info();
        let constants = Constants(vec![
            ("app", PathBuf::from(r"E:\Games\Tree")),
            ("src", PathBuf::from(r"D:\dl")),
            ("sys", PathBuf::from(known_folder(&FOLDERID_System))),
        ]);
        let actions = post_actions(&[3, 0, 3], &info, Some("en"), &constants).unwrap();
        assert_eq!(
            actions,
            vec![
                PostAction {
                    label: "Update DirectX".into(),
                    filename: PathBuf::from(r"E:\Games\Tree\_Redist\dxwebsetup.exe"),
                    parameters: String::new(),
                    working_dir: None,
                },
                PostAction {
                    label: "Update DirectX".into(),
                    filename: PathBuf::from(r"E:\Games\Tree\_Redist\vc_redist.x64.exe"),
                    parameters: "/q".into(),
                    working_dir: None,
                },
            ]
        );
        assert!(post_actions(&[1], &info, Some("en"), &constants).is_err(), "{{tmp}} is refused");
        assert!(post_actions(&[2], &info, Some("en"), &constants).is_err(), "URLs are refused");
        assert!(post_actions(&[4], &info, Some("en"), &constants).is_err(), "other languages are refused");
        assert!(post_actions(&[5], &info, Some("en"), &constants).is_err(), "only after-install entries");
        assert!(post_actions(&[6], &info, Some("en"), &constants).is_err(), "unknown constants are refused");
        assert!(post_actions(&[99], &info, Some("en"), &constants).is_err());
        assert_eq!(constants.expand("{{x}").unwrap(), "{x}");
    }

    #[test]
    fn temp_cleanup_only_touches_inno_temp_folders() {
        let dir = tempfile::tempdir().unwrap();
        let temp = dir.path();
        for name in ["is-AB12C.tmp", "is-.tmp", "other.tmp", "is-x y.tmp"] {
            std::fs::create_dir_all(temp.join(name)).unwrap();
        }
        assert!(is_installer_temp_dir(&temp.join("is-AB12C.tmp"), temp));
        assert!(!is_installer_temp_dir(&temp.join("is-.tmp"), temp));
        assert!(!is_installer_temp_dir(&temp.join("other.tmp"), temp));
        assert!(!is_installer_temp_dir(&temp.join("is-x y.tmp"), temp));
        assert!(!is_installer_temp_dir(&temp.join("is-AB12C.tmp").join("is-QQ.tmp"), temp));
        assert!(!is_installer_temp_dir(&temp.join("is-MISSING.tmp"), temp));
    }
}
