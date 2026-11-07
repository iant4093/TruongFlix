//! Reads everything a repack's Inno Setup installer would ask (components, tasks, languages, install
//! folder, after-install actions, shortcuts) without running it.

use std::path::{Path, PathBuf};

use inno::entry::RunFlags;
use inno::Inno;
use serde::Serialize;

// `ComponentFlags` / `TaskFlags` bits (not re-exported by the inno crate).
const COMPONENT_FIXED: u8 = 1;
const COMPONENT_EXCLUSIVE: u8 = 1 << 3;
const COMPONENT_DONT_INHERIT_CHECK: u8 = 1 << 4;
const TASK_EXCLUSIVE: u8 = 1;
const TASK_UNCHECKED: u8 = 1 << 1;
const TASK_DONT_INHERIT_CHECK: u8 = 1 << 4;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageInfo {
    pub name: String,
    pub display: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeInfo {
    pub name: String,
    pub description: String,
    pub languages: Option<String>,
    pub is_custom: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentInfo {
    pub name: String,
    pub description: String,
    pub types: Option<String>,
    pub languages: Option<String>,
    pub level: u32,
    pub size: u64,
    pub fixed: bool,
    pub exclusive: bool,
    pub dont_inherit_check: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    pub name: String,
    pub description: String,
    pub group_description: Option<String>,
    pub components: Option<String>,
    pub languages: Option<String>,
    pub level: u32,
    pub unchecked: bool,
    pub exclusive: bool,
    pub dont_inherit_check: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    pub filename: String,
    pub parameters: String,
    pub working_dir: Option<String>,
    pub description: String,
    pub post_install: bool,
    pub unchecked: bool,
    pub skip_if_silent: bool,
    pub shell_exec: bool,
    pub components: Option<String>,
    pub tasks: Option<String>,
    pub languages: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IconInfo {
    pub name: String,
    pub filename: String,
    pub components: Option<String>,
    pub tasks: Option<String>,
    pub languages: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageInfo {
    pub name: String,
    pub value: String,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallerInfo {
    pub setup_exe: String,
    pub app_name: String,
    pub default_dir_name: String,
    pub extra_disk_space: u64,
    pub languages: Vec<LanguageInfo>,
    pub types: Vec<TypeInfo>,
    pub components: Vec<ComponentInfo>,
    pub tasks: Vec<TaskInfo>,
    pub run_entries: Vec<RunInfo>,
    pub icons: Vec<IconInfo>,
    pub messages: Vec<MessageInfo>,
}

fn text(value: Option<&str>) -> String {
    value.unwrap_or_default().to_string()
}

fn opt(value: Option<&str>) -> Option<String> {
    value.map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
}

/// Repacks sometimes ship a corrected installer next to the original; prefer it.
pub fn find_setup(dir: &Path) -> Option<PathBuf> {
    for name in ["setup-fixed-ost.exe", "setup-FIXED.exe", "setup-fixed.exe", "setup.exe"] {
        let path = dir.join(name);
        if path.is_file() {
            return Some(path);
        }
    }
    let mut exes: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")))
        .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().to_ascii_lowercase().starts_with("setup")))
        .collect();
    exes.sort();
    exes.into_iter().next()
}

pub fn inspect(dir: &Path) -> Result<InstallerInfo, String> {
    let setup = find_setup(dir).ok_or_else(|| "No installer (setup.exe) was found in the download.".to_string())?;
    let file = std::fs::File::open(&setup).map_err(|e| format!("Could not open the installer: {e}"))?;
    let inno = Inno::new(std::io::BufReader::new(file))
        .map_err(|e| format!("This installer could not be read ({e}). Only Inno Setup installers are supported."))?;
    let header = inno.header();
    let languages = inno.languages();

    Ok(InstallerInfo {
        setup_exe: setup.to_string_lossy().into_owned(),
        app_name: text(header.app_name()),
        default_dir_name: text(header.default_dir_name()),
        extra_disk_space: header.extra_disk_space_required(),
        languages: languages
            .iter()
            .map(|l| LanguageInfo { name: l.name().to_string(), display: l.language_name().to_string() })
            .collect(),
        types: inno
            .type_entries()
            .iter()
            .map(|t| TypeInfo {
                name: text(t.name()),
                description: text(t.description()),
                languages: opt(t.languages()),
                is_custom: t.is_custom(),
            })
            .collect(),
        components: inno
            .components()
            .iter()
            .map(|c| ComponentInfo {
                name: text(c.name()),
                description: text(c.description()),
                types: opt(c.types()),
                languages: opt(c.languages()),
                level: c.level(),
                size: c.size().max(c.extra_disk_space_required()),
                fixed: c.flags().bits() & COMPONENT_FIXED != 0,
                exclusive: c.flags().bits() & COMPONENT_EXCLUSIVE != 0,
                dont_inherit_check: c.flags().bits() & COMPONENT_DONT_INHERIT_CHECK != 0,
            })
            .collect(),
        tasks: inno
            .tasks()
            .iter()
            .map(|t| TaskInfo {
                name: text(t.name()),
                description: text(t.description()),
                group_description: opt(t.group_description()),
                components: opt(t.components()),
                languages: opt(t.languages()),
                level: t.level(),
                unchecked: t.flags().bits() & TASK_UNCHECKED != 0,
                exclusive: t.flags().bits() & TASK_EXCLUSIVE != 0,
                dont_inherit_check: t.flags().bits() & TASK_DONT_INHERIT_CHECK != 0,
            })
            .collect(),
        run_entries: inno
            .run_entries()
            .iter()
            .map(|r| {
                let flags = r.options();
                RunInfo {
                    filename: text(r.name()),
                    parameters: text(r.parameters()),
                    working_dir: opt(r.working_directory()),
                    description: text(r.description()),
                    post_install: flags.contains(RunFlags::POST_INSTALL),
                    unchecked: flags.contains(RunFlags::UNCHECKED),
                    skip_if_silent: flags.contains(RunFlags::SKIP_IF_SILENT),
                    shell_exec: flags.contains(RunFlags::SHELL_EXECUTE),
                    components: opt(r.condition().as_str()),
                    tasks: opt(r.condition().tasks()),
                    languages: opt(r.condition().languages()),
                }
            })
            .collect(),
        icons: inno
            .icon_entries()
            .iter()
            .map(|i| IconInfo {
                name: text(i.name()),
                filename: text(i.filename()),
                components: opt(i.condition().as_str()),
                tasks: opt(i.condition().tasks()),
                languages: opt(i.condition().languages()),
            })
            .collect(),
        messages: inno
            .messages()
            .map(|m| MessageInfo {
                name: text(m.name()),
                value: text(m.value()),
                language: m.language().map(|l| l.name().to_string()),
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Set `TRUONGFLIX_TEST_INSTALLER_DIR` to a downloaded repack folder to check it parses.
    #[test]
    fn reads_a_real_repack_installer_when_available() {
        let Ok(dir) = std::env::var("TRUONGFLIX_TEST_INSTALLER_DIR") else {
            return;
        };
        let info = inspect(Path::new(&dir)).expect("installer parses");
        assert!(!info.app_name.is_empty());
        assert!(!info.components.is_empty());
        println!("{}", serde_json::to_string_pretty(&info).unwrap());
    }

    #[test]
    fn prefers_fixed_installers() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("setup.exe"), b"").unwrap();
        assert_eq!(find_setup(dir.path()), Some(dir.path().join("setup.exe")));
        std::fs::write(dir.path().join("setup-FIXED.exe"), b"").unwrap();
        assert_eq!(find_setup(dir.path()), Some(dir.path().join("setup-FIXED.exe")));
        assert!(find_setup(&dir.path().join("missing")).is_none());
    }
}
