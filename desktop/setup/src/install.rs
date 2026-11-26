//! Install and uninstall steps (docs/contracts/desktop-shell.md「Windows 安装程序」).
//!
//! Whatever the app is built with, it arrives as files (`payload.rs`): they go into the install
//! folder as they are, next to `uninstall.exe`; the app downloads its runtime on first start.
//! Start menu and desktop
//! `<product>.lnk` and `HKCU\…\Uninstall\<product>` are the same as the earlier NSIS installer
//! wrote, so an install over it takes it over in place.

use crate::{
    payload::{self, Manifest, Payload},
    system,
    takeover::{self, Earlier},
};
use std::{
    fs,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};
use winreg::{enums::*, RegKey};

pub const UNINSTALL_ROOT: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
/// Written by the earlier NSIS installer (`Software\<publisher>\<product>`); removed on takeover.
pub const NSIS_PUBLISHER_KEY: &str = r"Software\atelier";
/// Shared with the shell and the Python side, independent of the product name.
const RUNTIME_PARENT: &str = r"game-atelier\runtime";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const QUIT_WAIT: Duration = Duration::from_secs(90);
/// After the app's processes are gone, how long its files may stay held (an exe image Windows has
/// not let go of yet, a scanner reading it) before the install gives up without changing anything.
const RELEASE_WAIT: Duration = Duration::from_secs(30);
/// Windows error 145: the folder is not empty (the user put something there).
const ERROR_DIR_NOT_EMPTY: i32 = 145;
pub const UNINSTALLER: &str = "uninstall.exe";

pub fn log(line: &str) {
    use std::io::Write;
    let path = std::env::temp_dir().join("atelier-setup.log");
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

fn local_app_data() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

pub fn runtime_parent() -> PathBuf {
    local_app_data().join(RUNTIME_PARENT)
}

pub fn default_dir(product: &str) -> PathBuf {
    local_app_data().join(product)
}

/// A folder the user picked: install into `<picked>\<product>` unless it already is one, so
/// that uninstalling never empties a folder the user chose for other things.
pub fn resolve_dir(picked: &Path, product: &str) -> PathBuf {
    let named = picked
        .file_name()
        .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(product));
    if named {
        picked.to_path_buf()
    } else {
        picked.join(product)
    }
}

/// The main program inside an install folder (`main` is the manifest's relative path).
pub fn app_exe(dir: &Path, main: &str) -> PathBuf {
    dir.join(main)
}

pub struct Existing {
    pub dir: PathBuf,
    pub version: Option<String>,
}

/// The install recorded in Settings > Apps (ours, or the earlier NSIS one).
pub fn existing(product: &str, main: &str) -> Option<Existing> {
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(format!(r"{UNINSTALL_ROOT}\{product}"))
        .ok()?;
    let location: String = key.get_value("InstallLocation").ok()?;
    let dir = PathBuf::from(location.trim().trim_matches('"'));
    app_exe(&dir, main).is_file().then(|| Existing {
        dir,
        version: key.get_value("DisplayVersion").ok(),
    })
}

pub fn app_running(dir: &Path) -> bool {
    !system::processes_under(dir).is_empty()
}

/// Ask a running shell to quit through its own flow (it confirms while work is running), then
/// wait for it to go. False when it is still running after the wait.
pub fn quit_app(dir: &Path, main: &str) -> bool {
    log("asking the running app to quit");
    let _ = Command::new(app_exe(dir, main))
        .arg("--quit")
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
    let started = Instant::now();
    while app_running(dir) {
        if started.elapsed() > QUIT_WAIT {
            return false;
        }
        thread::sleep(Duration::from_millis(500));
    }
    true
}

/// Wait until no other process holds any of `files`. Fails, naming the file, after RELEASE_WAIT.
pub fn wait_until_released(dir: &Path, files: &[PathBuf]) -> Result<(), String> {
    let started = Instant::now();
    let mut delay = Duration::from_millis(100);
    loop {
        let Some(held) = files.iter().find(|f| system::held_elsewhere(f)) else {
            if started.elapsed() >= Duration::from_millis(100) {
                log(&format!(
                    "files released after {} ms",
                    started.elapsed().as_millis()
                ));
            }
            return Ok(());
        };
        if started.elapsed() > RELEASE_WAIT {
            let name = held.strip_prefix(dir).unwrap_or(held).display();
            log(&format!(
                "still held after {} s: {name}",
                RELEASE_WAIT.as_secs()
            ));
            return Err(format!("{name} 仍在被其他程序使用，稍等片刻后点「重试」"));
        }
        thread::sleep(delay);
        delay = (delay * 2).min(Duration::from_secs(2));
    }
}

fn remove_dir_with_retry(path: &Path) -> Result<(), String> {
    let mut attempt = 0;
    loop {
        match fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) if attempt == 9 => return Err(format!("无法删除 {}：{e}", path.display())),
            Err(_) => thread::sleep(Duration::from_millis(500)),
        }
        attempt += 1;
    }
}

fn stop_processes_under(dir: &Path) {
    for (pid, path) in system::processes_under(dir) {
        log(&format!("stopping {pid} {}", path.display()));
        system::terminate(pid);
    }
}

pub struct Plan {
    pub dir: PathBuf,
    pub desktop_shortcut: bool,
    /// An install under an earlier product name, taken over by this one (`takeover.rs`).
    pub earlier: Option<Earlier>,
}

/// Whether the app runs from the folder being installed into, or from the install taken over.
pub fn plan_running(plan: &Plan) -> bool {
    app_running(&plan.dir) || plan.earlier.as_ref().is_some_and(|e| app_running(&e.dir))
}

/// Quit the app wherever the plan finds it running; false when one of them is still running.
pub fn quit_plan(plan: &Plan, main: &str) -> bool {
    let earlier = plan
        .earlier
        .as_ref()
        .is_none_or(|e| !app_running(&e.dir) || quit_app(&e.dir, &e.main));
    earlier && (!app_running(&plan.dir) || quit_app(&plan.dir, main))
}

pub fn install(payload: &Payload, plan: &Plan, report: &mut dyn FnMut(f64)) -> Result<(), String> {
    let manifest = &payload.manifest;
    let product = manifest.product.as_str();
    let dir = plan.dir.as_path();
    log(&format!(
        "install {product} {} into {}",
        manifest.version,
        dir.display()
    ));
    fs::create_dir_all(dir).map_err(|e| format!("无法创建安装目录：{e}"))?;
    report(0.0);
    // Over an existing install, the running shell quits through its own flow first (contract);
    // with nothing running, `--quit` just exits.
    if app_exe(dir, &manifest.main).is_file() && !quit_app(dir, &manifest.main) {
        return Err(format!("{product} 没有退出，请从任务栏通知区域退出后重试"));
    }
    // The install taken over may still be running under its own name.
    if let Some(earlier) = &plan.earlier {
        if app_exe(&earlier.dir, &earlier.main).is_file() && !quit_app(&earlier.dir, &earlier.main)
        {
            return Err(format!(
                "{} 没有退出，请从任务栏通知区域退出后重试",
                earlier.product
            ));
        }
        stop_processes_under(&earlier.dir);
    }

    if !payload.app_files().any(|f| f.path == manifest.main) {
        return Err("安装程序里缺少应用".into());
    }
    // 1. Files: the app as built, then the uninstaller that remembers them all. The runtime is
    // the app's own business: it downloads it on first start (contract). Nothing in the folder
    // changes until every file it replaces is free and every new file is written next to it.
    let mut targets: Vec<PathBuf> = payload.app_files().map(|f| dir.join(&f.path)).collect();
    targets.push(dir.join(UNINSTALLER));
    wait_until_released(dir, &targets)?;
    let partials = unpack_all(payload, dir, report)?;
    for (done, (partial, dest)) in partials.iter().enumerate() {
        if let Err(e) = payload::replace(partial, dest) {
            for (left, _) in &partials[done..] {
                let _ = fs::remove_file(left);
            }
            return Err(e);
        }
    }
    let mut installed: Vec<String> = payload.app_files().map(|f| f.path.clone()).collect();
    installed.push(UNINSTALLER.to_string());
    payload.write_uninstaller(&dir.join(UNINSTALLER), installed.clone())?;

    // 2. Shortcuts and the Settings > Apps entry. Taking over, the desktop shortcut follows
    // whether the earlier install had one.
    let exe = app_exe(dir, &manifest.main);
    let link = format!("{product}.lnk");
    if let Some(programs) = system::programs_dir() {
        system::create_shortcut(&programs.join(&link), &exe, &manifest.app_id)?;
    }
    let desktop_shortcut =
        plan.desktop_shortcut && plan.earlier.as_ref().is_none_or(|e| e.desktop_shortcut);
    if let Some(desktop) = system::desktop_dir() {
        let shortcut = desktop.join(&link);
        if desktop_shortcut {
            system::create_shortcut(&shortcut, &exe, &manifest.app_id)?;
        } else {
            let _ = fs::remove_file(shortcut);
        }
    }
    register(payload, dir)?;
    // 3. Only now, with the new install complete, the one it takes over goes.
    if let Some(earlier) = &plan.earlier {
        takeover::retire(earlier, dir, &installed, &exe, &manifest.app_id);
    }
    report(1.0);
    log("install finished");
    Ok(())
}

/// Every app file written as its `.partial` next to where it goes: `(partial, destination)`.
/// On failure the partials written so far are removed and the install is left as it was.
fn unpack_all(
    payload: &Payload,
    dir: &Path,
    report: &mut dyn FnMut(f64),
) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    let total = payload.app_files().map(|f| f.size).sum::<u64>().max(1) as f64;
    let mut copied = 0u64;
    let mut progress = |n: u64| {
        copied += n;
        report(0.95 * copied as f64 / total);
    };
    let mut partials = Vec::new();
    for entry in payload.app_files() {
        let dest = dir.join(&entry.path);
        match payload.unpack(entry, &dest, &mut progress) {
            Ok(partial) => partials.push((partial, dest)),
            Err(e) => {
                let _ = fs::remove_file(payload::partial_path(&dest));
                for (partial, _) in &partials {
                    let _ = fs::remove_file(partial);
                }
                return Err(e);
            }
        }
    }
    Ok(partials)
}

fn dir_size_kb(dir: &Path) -> u32 {
    fn walk(dir: &Path) -> u64 {
        fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|e| match e.metadata() {
                        Ok(m) if m.is_dir() => walk(&e.path()),
                        Ok(m) => m.len(),
                        Err(_) => 0,
                    })
                    .sum()
            })
            .unwrap_or(0)
    }
    (walk(dir) / 1024).min(u32::MAX as u64) as u32
}

fn register(payload: &Payload, dir: &Path) -> Result<(), String> {
    let product = &payload.manifest.product;
    let fail = |e: std::io::Error| format!("无法写入「设置 → 应用」条目：{e}");
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey(format!(r"{UNINSTALL_ROOT}\{product}"))
        .map_err(fail)?;
    let exe = app_exe(dir, &payload.manifest.main);
    let uninstaller = dir.join(UNINSTALLER);
    // Values the NSIS installer wrote and nothing reads any more.
    for stale in ["MainBinaryName", "CurrentUser", "AllUsers"] {
        let _ = key.delete_value(stale);
    }
    key.set_value("DisplayName", product).map_err(fail)?;
    key.set_value("DisplayIcon", &format!("\"{}\"", exe.display()))
        .map_err(fail)?;
    key.set_value("DisplayVersion", &payload.manifest.version)
        .map_err(fail)?;
    key.set_value("Publisher", product).map_err(fail)?;
    key.set_value("InstallLocation", &format!("\"{}\"", dir.display()))
        .map_err(fail)?;
    key.set_value("UninstallString", &format!("\"{}\"", uninstaller.display()))
        .map_err(fail)?;
    key.set_value(
        "QuietUninstallString",
        &format!("\"{}\" --silent", uninstaller.display()),
    )
    .map_err(fail)?;
    key.set_value("NoModify", &1u32).map_err(fail)?;
    key.set_value("NoRepair", &1u32).map_err(fail)?;
    key.set_value("EstimatedSize", &dir_size_kb(dir))
        .map_err(fail)?;
    let _ = hkcu.delete_subkey_all(format!(r"{NSIS_PUBLISHER_KEY}\{product}"));
    Ok(())
}

pub fn uninstall(
    manifest: &Manifest,
    dir: &Path,
    report: &mut dyn FnMut(f64),
) -> Result<(), String> {
    let product = manifest.product.as_str();
    log(&format!("uninstall {product} from {}", dir.display()));
    let runtime = runtime_parent();
    // The app has quit by now (the caller asked it to); stop what is left, servers included.
    stop_processes_under(dir);
    stop_processes_under(&runtime);
    report(0.1);
    let link = format!("{product}.lnk");
    for folder in [system::programs_dir(), system::desktop_dir()]
        .into_iter()
        .flatten()
    {
        let _ = fs::remove_file(folder.join(&link));
    }
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let _ = hkcu.delete_subkey_all(format!(r"{UNINSTALL_ROOT}\{product}"));
    let _ = hkcu.delete_subkey_all(format!(r"{NSIS_PUBLISHER_KEY}\{product}"));
    report(0.25);
    // The runtime lives outside the install folder; the data root is never touched.
    remove_dir_with_retry(&runtime)?;
    report(0.85);
    // Only what the installer put there, then the folders that left empty.
    remove_installed(dir, &manifest.installed);
    remove_install_folder(dir);
    report(1.0);
    log("uninstall finished");
    Ok(())
}

pub fn remove_installed(dir: &Path, installed: &[String]) {
    let mut parents = Vec::new();
    for path in installed {
        let file = dir.join(path);
        let _ = fs::remove_file(&file);
        let mut parent = file.parent();
        while let Some(folder) = parent.filter(|p| system::is_within(p, dir)) {
            parents.push(folder.to_path_buf());
            parent = folder.parent();
        }
    }
    // Deepest first; `remove_dir` only removes empty folders, so anything else stays.
    parents.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
    parents.dedup();
    for folder in parents {
        let _ = fs::remove_dir(folder);
    }
}

/// The install folder itself, once empty. Another process's handle on it (a scanner, a process
/// started from it) can hold it for a moment; what still holds it is removed when this process
/// exits (`cleanup` in main.rs). A folder with the user's own files in it stays.
pub fn remove_install_folder(dir: &Path) {
    for _ in 0..10 {
        match fs::remove_dir(dir) {
            Ok(()) => return,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) if e.raw_os_error() == Some(ERROR_DIR_NOT_EMPTY) => {
                log(&format!("kept {}: not empty", dir.display()));
                return;
            }
            Err(e) => {
                log(&format!("{} still in use ({e})", dir.display()));
                thread::sleep(Duration::from_millis(500));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_picked_folder_gets_its_own_product_folder() {
        let product = "Atelier";
        assert_eq!(
            resolve_dir(Path::new(r"D:\Apps"), product),
            PathBuf::from(r"D:\Apps\Atelier")
        );
        assert_eq!(
            resolve_dir(Path::new(r"D:\Apps\atelier"), product),
            PathBuf::from(r"D:\Apps\atelier")
        );
    }

    #[test]
    fn uninstall_removes_only_what_was_installed() {
        let dir = std::env::temp_dir().join(format!("atelier-setup-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for path in [
            "Atelier.exe",
            "resources/app.asar",
            "locales/zh-CN.pak",
            "notes.txt",
        ] {
            let file = dir.join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, b"x").unwrap();
        }
        let installed =
            ["Atelier.exe", "resources/app.asar", "locales/zh-CN.pak"].map(String::from);
        remove_installed(&dir, &installed);
        assert!(
            dir.join("notes.txt").is_file(),
            "a file the user put there stays"
        );
        assert!(!dir.join("resources").exists() && !dir.join("locales").exists());
        fs::remove_file(dir.join("notes.txt")).unwrap();
        remove_installed(&dir, &[]);
        let _ = fs::remove_dir(&dir);
        assert!(!dir.exists());
    }

    #[test]
    fn a_file_open_in_another_handle_counts_as_held() {
        let file = std::env::temp_dir().join(format!("atelier-held-{}.exe", std::process::id()));
        fs::write(&file, b"x").unwrap();
        let open = fs::File::open(&file).unwrap();
        assert!(system::held_elsewhere(&file));
        drop(open);
        assert!(!system::held_elsewhere(&file));
        assert_eq!(fs::read(&file).unwrap(), b"x", "the probe writes nothing");
        fs::remove_file(&file).unwrap();
        assert!(
            !system::held_elsewhere(&file),
            "a missing file is held by no one"
        );
    }

    #[test]
    fn the_install_folder_goes_only_when_empty() {
        let dir = std::env::temp_dir().join(format!("atelier-folder-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("notes.txt"), b"mine").unwrap();
        remove_install_folder(&dir);
        assert!(dir.join("notes.txt").is_file());
        fs::remove_file(dir.join("notes.txt")).unwrap();
        remove_install_folder(&dir);
        assert!(!dir.exists());
    }

    #[test]
    fn within_is_case_insensitive_and_needs_a_separator() {
        assert!(system::is_within(
            Path::new(r"C:\Users\A\AppData\Local\Atelier\Atelier.exe"),
            Path::new(r"c:\users\a\appdata\local\atelier")
        ));
        assert!(!system::is_within(
            Path::new(r"C:\Apps\Atelier2\Atelier.exe"),
            Path::new(r"C:\Apps\Atelier")
        ));
    }
}
