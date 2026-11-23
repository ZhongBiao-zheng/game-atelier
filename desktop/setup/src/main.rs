//! Atelier's Windows installer and uninstaller (docs/contracts/desktop-shell.md「Windows 安装程序」).
//!
//! One exe, two roles, chosen by the manifest appended to it (`payload.rs`):
//! - install (`Atelier-<version>-windows-x64-setup.exe`): window, or `--silent [--dir <path>]
//!   [--no-desktop-shortcut]`;
//! - uninstall (`<install dir>\uninstall.exe`): window, or `--silent`. It first copies itself to
//!   %TEMP% and runs from there (`--relocated <dir>`), so it can remove its own folder.
//!
//! CI only: `--preview <state>` renders one state of the window; `--auto` clicks the main button.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
mod install;
#[cfg(windows)]
mod payload;
#[cfg(windows)]
mod system;
#[cfg(windows)]
mod ui;

#[cfg(not(windows))]
fn main() {
    eprintln!("atelier-setup only runs on Windows");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    std::process::exit(windows_main::run());
}

#[cfg(windows)]
mod windows_main {
    use crate::{
        install::{self, Plan},
        payload::{Payload, Role, SETUP_ONLY},
        system, ui,
    };
    use std::{os::windows::process::CommandExt, path::PathBuf, process::Command};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const WEBVIEW2_SETUP: &str = "MicrosoftEdgeWebview2Setup.exe";

    #[derive(Default)]
    struct Args {
        silent: bool,
        dir: Option<PathBuf>,
        no_desktop_shortcut: bool,
        preview: Option<String>,
        auto: bool,
        relocated: Option<PathBuf>,
    }

    fn parse_args() -> Args {
        let mut args = Args::default();
        let mut it = std::env::args().skip(1);
        while let Some(arg) = it.next() {
            match arg.as_str() {
                "--silent" => args.silent = true,
                "--dir" => args.dir = it.next().map(PathBuf::from),
                "--no-desktop-shortcut" => args.no_desktop_shortcut = true,
                "--preview" => args.preview = it.next(),
                "--auto" => args.auto = true,
                "--relocated" => args.relocated = it.next().map(PathBuf::from),
                _ => {}
            }
        }
        args
    }

    pub fn run() -> i32 {
        // Release builds abort on panic without a console: leave the reason in the setup log.
        std::panic::set_hook(Box::new(|info| install::log(&format!("panic: {info}"))));
        let args = parse_args();
        let payload = match Payload::read_self() {
            Ok(payload) => payload,
            Err(e) => {
                install::log(&format!("payload: {e}"));
                if !args.silent {
                    system::alert("Atelier", &e);
                }
                return 1;
            }
        };
        match payload.manifest.role {
            Role::Install => run_install(payload, args),
            Role::Uninstall => run_uninstall(payload, args),
        }
    }

    fn report_exit(product: &str, silent: bool, result: Result<(), String>) -> i32 {
        match result {
            Ok(()) => 0,
            Err(e) => {
                install::log(&format!("failed: {e}"));
                if !silent {
                    system::alert(product, &e);
                }
                1
            }
        }
    }

    fn run_install(payload: Payload, args: Args) -> i32 {
        let product = payload.manifest.product.clone();
        let main = payload.manifest.main.clone();
        let existing = install::existing(&product, &main);
        let dir = args
            .dir
            .clone()
            .or_else(|| existing.as_ref().map(|e| e.dir.clone()))
            .unwrap_or_else(|| install::default_dir(&product));
        if args.silent {
            if install::app_running(&dir) && !install::quit_app(&dir, &main) {
                install::log("the app is still running");
                return 3;
            }
            let plan = Plan {
                dir,
                desktop_shortcut: !args.no_desktop_shortcut,
            };
            let result = install::install(&payload, &plan, &mut |_| {});
            return report_exit(&product, true, result);
        }
        if !ensure_webview2(&payload) {
            return 1;
        }
        let code = ui::run(ui::Context {
            dir,
            existing_version: existing.and_then(|e| e.version),
            preview: args.preview,
            auto: args.auto,
            payload,
        });
        cleanup(None, None);
        code
    }

    /// The window needs WebView2. Windows 11 ships it and most Windows 10 machines received it
    /// through Windows Update; the rest install it here with the bundled bootstrapper.
    fn ensure_webview2(payload: &Payload) -> bool {
        if system::webview2_installed() {
            return true;
        }
        let product = &payload.manifest.product;
        let Some(entry) = payload.entry(&format!("{SETUP_ONLY}{WEBVIEW2_SETUP}")) else {
            system::alert(product, "需要先安装 Microsoft Edge WebView2");
            return false;
        };
        let text =
            format!("{product} 需要 Microsoft Edge WebView2。点「确定」联网安装，约需一分钟。");
        if !system::confirm(product, &text) {
            return false;
        }
        let bootstrapper = std::env::temp_dir().join(WEBVIEW2_SETUP);
        let ran = payload
            .extract(entry, &bootstrapper, &mut |_| {})
            .and_then(|()| {
                Command::new(&bootstrapper)
                    .args(["/silent", "/install"])
                    .status()
                    .map_err(|e| e.to_string())
            });
        let _ = std::fs::remove_file(&bootstrapper);
        install::log(&format!("webview2 bootstrapper: {ran:?}"));
        if system::webview2_installed() {
            return true;
        }
        system::alert(
            product,
            "没能安装 Microsoft Edge WebView2，请检查网络后重新运行安装程序",
        );
        false
    }

    fn run_uninstall(payload: Payload, args: Args) -> i32 {
        let product = payload.manifest.product.clone();
        let main = payload.manifest.main.clone();
        let Some(dir) = args.relocated.clone() else {
            return relocate(&product, &args);
        };
        let code = if args.silent {
            if install::app_running(&dir) && !install::quit_app(&dir, &main) {
                install::log("the app is still running");
                3
            } else {
                let result = install::uninstall(&payload.manifest, &dir, &mut |_| {});
                report_exit(&product, true, result)
            }
        } else {
            ui::run(ui::Context {
                dir: dir.clone(),
                existing_version: None,
                preview: None,
                auto: args.auto,
                payload,
            })
        };
        cleanup(std::env::current_exe().ok(), Some(&dir));
        code
    }

    /// Copy the uninstaller to %TEMP% and run it from there, so the install folder can go.
    fn relocate(product: &str, args: &Args) -> i32 {
        let started = (|| -> Result<(), String> {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let dir = exe.parent().ok_or("no install folder")?.to_path_buf();
            let copy =
                std::env::temp_dir().join(format!("atelier-uninstall-{}.exe", std::process::id()));
            std::fs::copy(&exe, &copy).map_err(|e| e.to_string())?;
            let mut command = Command::new(&copy);
            // Not the inherited working folder: started from the install folder (Explorer does
            // that), the copy and its WebView2 processes would hold it open and it could not go.
            command.current_dir(std::env::temp_dir());
            command.arg("--relocated").arg(&dir);
            if args.silent {
                command.arg("--silent");
            }
            if args.auto {
                command.arg("--auto");
            }
            command.spawn().map(|_| ()).map_err(|e| e.to_string())
        })();
        report_exit(product, args.silent, started)
    }

    /// Remove the WebView2 profile, and this exe when it is the relocated uninstaller, once
    /// this process has gone (a running exe cannot delete itself). After an uninstall, also the
    /// install folder if it is empty by then (plain `rmdir` never removes a folder with files).
    fn cleanup(own_exe: Option<PathBuf>, install_dir: Option<&std::path::Path>) {
        let mut script = format!(
            "ping 127.0.0.1 -n 4 > nul & rmdir /s /q \"{}\"",
            ui::webview_data_dir().display()
        );
        if let Some(exe) = own_exe {
            script.push_str(&format!(" & del /f /q \"{}\"", exe.display()));
        }
        if let Some(dir) = install_dir {
            script.push_str(&format!(" & rmdir \"{}\" 2> nul", dir.display()));
        }
        let _ = Command::new("cmd")
            .args(["/d", "/c"])
            .raw_arg(script)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
}
