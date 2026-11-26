//! Taking over an install recorded under an earlier product name (docs/contracts/desktop-shell.md
//! 「Windows 安装程序」): the app was called Atelier before it was renamed. Its Start menu entry,
//! Settings > Apps entry and main program all carry that name, so without this an install would
//! sit next to it as a second app, and uninstalling the old one would remove the runtime both use.
//!
//! The earlier install is retired by hand, never through its own uninstaller (that removes the
//! runtime): its shortcuts, its Apps entry and the files its installer recorded. The runtime and
//! the data root are left alone.

use crate::{install, payload, system};
use std::path::{Path, PathBuf};
use winreg::{enums::*, RegKey};

/// Names this app was installed under before, newest first.
pub const EARLIER_PRODUCTS: &[&str] = &["Atelier"];

#[derive(Clone, Debug)]
pub struct Earlier {
    pub product: String,
    pub dir: PathBuf,
    /// Its main program, relative to `dir`.
    pub main: String,
    pub version: Option<String>,
    /// What its installer put in `dir` (relative paths).
    pub installed: Vec<String>,
    /// Whether it had a shortcut on the desktop; the takeover keeps that choice.
    pub desktop_shortcut: bool,
}

/// An install of this app recorded in Settings > Apps under an earlier name. `main` and
/// `app_files` are this installer's: when the earlier uninstaller carries no file list (the NSIS
/// installer before ours), its files are taken to be these, with its own main program.
pub fn find(product: &str, main: &str, app_files: &[String]) -> Option<Earlier> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    EARLIER_PRODUCTS
        .iter()
        .filter(|name| !name.eq_ignore_ascii_case(product))
        .find_map(|name| {
            let key = hkcu
                .open_subkey(format!(r"{}\{name}", install::UNINSTALL_ROOT))
                .ok()?;
            let location: String = key.get_value("InstallLocation").ok()?;
            let dir = PathBuf::from(location.trim().trim_matches('"'));
            if dir.as_os_str().is_empty() {
                return None;
            }
            let recorded = payload::read_manifest(&dir.join(install::UNINSTALLER))
                .ok()
                .filter(|m| m.role == payload::Role::Uninstall && !m.installed.is_empty());
            let (earlier_main, installed) = match recorded {
                Some(m) => (m.main, m.installed),
                None => {
                    let earlier_main = format!("{name}.exe");
                    let files = known_files(app_files, main, &earlier_main);
                    (earlier_main, files)
                }
            };
            let desktop_shortcut = system::desktop_dir()
                .is_some_and(|desktop| desktop.join(format!("{name}.lnk")).is_file());
            install::log(&format!(
                "earlier install {name} in {} ({} files recorded)",
                dir.display(),
                installed.len()
            ));
            Some(Earlier {
                product: name.to_string(),
                dir,
                main: earlier_main,
                version: key.get_value("DisplayVersion").ok(),
                installed,
                desktop_shortcut,
            })
        })
}

/// The app's files as an earlier installer would have named them.
fn known_files(app_files: &[String], main: &str, earlier_main: &str) -> Vec<String> {
    app_files
        .iter()
        .filter(|f| !f.eq_ignore_ascii_case(main))
        .cloned()
        .chain([earlier_main.to_string(), install::UNINSTALLER.to_string()])
        .collect()
}

/// Where the takeover installs: the earlier folder's sibling under the new name when the folder
/// carries the earlier name (the default `%LOCALAPPDATA%\Atelier`, or `<picked>\Atelier` the
/// installer made in a folder the user chose), so the location the user picked is kept; the
/// earlier folder itself when it has any other name (the user named it).
pub fn target_dir(earlier_dir: &Path, earlier_product: &str, product: &str) -> PathBuf {
    let named = earlier_dir
        .file_name()
        .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(earlier_product));
    match earlier_dir.parent() {
        Some(parent) if named => parent.join(product),
        _ => earlier_dir.to_path_buf(),
    }
}

fn same_folder(a: &Path, b: &Path) -> bool {
    system::is_within(a, b) && system::is_within(b, a)
}

/// The earlier installer's files to remove, relative to its folder: none the new install just
/// wrote there (same folder), none outside the folder, none inside the runtime.
pub fn stale_files(
    earlier: &Earlier,
    target: &Path,
    installed_now: &[String],
    runtime: &Path,
) -> Vec<String> {
    let same = same_folder(&earlier.dir, target);
    earlier
        .installed
        .iter()
        .filter(|path| relative_inside(path))
        .filter(|path| !(same && installed_now.iter().any(|n| same_path(n, path))))
        .filter(|path| !system::is_within(&earlier.dir.join(path), runtime))
        .cloned()
        .collect()
}

fn same_path(a: &str, b: &str) -> bool {
    a.replace('\\', "/")
        .eq_ignore_ascii_case(&b.replace('\\', "/"))
}

/// A plain relative path: no root, no drive, no `..`.
fn relative_inside(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with(['/', '\\'])
        && !path.contains(':')
        && path.split(['/', '\\']).all(|part| part != "..")
}

/// After the new install is in place: remove the earlier shortcuts (a pinned taskbar shortcut is
/// pointed at the new program instead, so the pin keeps working), its Apps entry and its files.
pub fn retire(
    earlier: &Earlier,
    target: &Path,
    installed_now: &[String],
    exe: &Path,
    app_id: &str,
) {
    let name = &earlier.product;
    install::log(&format!(
        "retiring earlier install {name} in {}",
        earlier.dir.display()
    ));
    let link = format!("{name}.lnk");
    for folder in [system::programs_dir(), system::desktop_dir()]
        .into_iter()
        .flatten()
    {
        let _ = std::fs::remove_file(folder.join(&link));
    }
    if let Some(pinned) = system::taskbar_pins_dir().map(|d| d.join(&link)) {
        if pinned.is_file() {
            if let Err(e) = system::create_shortcut(&pinned, exe, app_id) {
                install::log(&format!("pinned shortcut not updated: {e}"));
            }
        }
    }
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let _ = hkcu.delete_subkey_all(format!(r"{}\{name}", install::UNINSTALL_ROOT));
    let _ = hkcu.delete_subkey_all(format!(r"{}\{name}", install::NSIS_PUBLISHER_KEY));
    let stale = stale_files(earlier, target, installed_now, &install::runtime_parent());
    // Its program has only just quit: Windows can hold the image for a moment.
    let files: Vec<PathBuf> = stale.iter().map(|f| earlier.dir.join(f)).collect();
    if let Err(e) = install::wait_until_released(&earlier.dir, &files) {
        install::log(&format!("earlier files still held: {e}"));
    }
    install::remove_installed(&earlier.dir, &stale);
    if !same_folder(&earlier.dir, target) {
        install::remove_install_folder(&earlier.dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn earlier(dir: &Path, installed: &[&str]) -> Earlier {
        Earlier {
            product: "Atelier".into(),
            dir: dir.to_path_buf(),
            main: "Atelier.exe".into(),
            version: Some("5.143.0".into()),
            installed: installed.iter().map(|s| s.to_string()).collect(),
            desktop_shortcut: true,
        }
    }

    #[test]
    fn a_folder_named_after_the_earlier_product_moves_to_its_sibling() {
        let local = r"C:\Users\A\AppData\Local";
        assert_eq!(
            target_dir(
                Path::new(&format!(r"{local}\Atelier")),
                "Atelier",
                "Cobrush"
            ),
            PathBuf::from(format!(r"{local}\Cobrush"))
        );
        assert_eq!(
            target_dir(Path::new(r"D:\Apps\atelier"), "Atelier", "Cobrush"),
            PathBuf::from(r"D:\Apps\Cobrush"),
            "a folder the user picked keeps its location"
        );
        assert_eq!(
            target_dir(Path::new(r"D:\Tools\Paint"), "Atelier", "Cobrush"),
            PathBuf::from(r"D:\Tools\Paint"),
            "a folder the user named stays"
        );
    }

    #[test]
    fn without_a_recorded_list_the_files_are_the_apps_under_the_earlier_main() {
        let app = ["Cobrush.exe", "resources/app.asar", "ffmpeg.dll"].map(String::from);
        assert_eq!(
            known_files(&app, "Cobrush.exe", "Atelier.exe"),
            [
                "resources/app.asar",
                "ffmpeg.dll",
                "Atelier.exe",
                "uninstall.exe"
            ]
            .map(String::from)
        );
    }

    #[test]
    fn stale_files_in_another_folder_are_all_of_them() {
        let old = earlier(
            Path::new(r"C:\L\Atelier"),
            &["Atelier.exe", "resources/app.asar", "uninstall.exe"],
        );
        let now = ["Cobrush.exe", "resources/app.asar", "uninstall.exe"].map(String::from);
        let runtime = Path::new(r"C:\L\game-atelier\runtime");
        assert_eq!(
            stale_files(&old, Path::new(r"C:\L\Cobrush"), &now, runtime),
            ["Atelier.exe", "resources/app.asar", "uninstall.exe"].map(String::from)
        );
    }

    #[test]
    fn in_the_same_folder_only_what_the_new_install_did_not_write_goes() {
        let old = earlier(
            Path::new(r"D:\Tools\Paint"),
            &[
                "Atelier.exe",
                r"Resources\app.asar",
                "uninstall.exe",
                "old.dll",
            ],
        );
        let now = ["Cobrush.exe", "resources/app.asar", "uninstall.exe"].map(String::from);
        let runtime = Path::new(r"C:\L\game-atelier\runtime");
        assert_eq!(
            stale_files(&old, Path::new(r"d:\tools\paint"), &now, runtime),
            ["Atelier.exe", "old.dll"].map(String::from)
        );
    }

    #[test]
    fn nothing_outside_the_folder_or_inside_the_runtime_is_ever_listed() {
        let old = earlier(
            Path::new(r"C:\L"),
            &[
                "Atelier.exe",
                r"..\game-atelier\runtime\GameAtelier\current",
                r"C:\Windows\notepad.exe",
                "/etc/hosts",
                r"game-atelier\runtime\shell.log",
                "",
            ],
        );
        let runtime = Path::new(r"C:\L\game-atelier\runtime");
        assert_eq!(
            stale_files(&old, Path::new(r"C:\L\Cobrush"), &[], runtime),
            ["Atelier.exe"].map(String::from)
        );
    }

    #[test]
    fn retiring_removes_the_recorded_files_and_the_emptied_folder() {
        let root = std::env::temp_dir().join(format!("atelier-takeover-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (old_dir, new_dir) = (root.join("Atelier"), root.join("Cobrush"));
        let runtime = root.join(r"game-atelier\runtime");
        for file in [
            old_dir.join("Atelier.exe"),
            old_dir.join(r"resources\app.asar"),
            old_dir.join("uninstall.exe"),
            runtime.join("shell.log"),
        ] {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, b"x").unwrap();
        }
        let old = earlier(
            &old_dir,
            &["Atelier.exe", "resources/app.asar", "uninstall.exe"],
        );
        let stale = stale_files(&old, &new_dir, &[], &runtime);
        install::remove_installed(&old_dir, &stale);
        install::remove_install_folder(&old_dir);
        assert!(!old_dir.exists());
        assert!(runtime.join("shell.log").is_file(), "the runtime stays");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
