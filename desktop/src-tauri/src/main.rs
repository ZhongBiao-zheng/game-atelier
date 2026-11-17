// Atelier desktop shell: a window, a tray icon and the viewer-server's lifetime. No business logic.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod runtime;

use runtime::{log, Runtime, Server};
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent},
    AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const PROBE_INTERVAL: Duration = Duration::from_secs(3);
/// About nine seconds without an answer before the window reports a stopped server.
const FAILED_PROBES_BEFORE_ERROR: u32 = 3;
const DOWNLOAD_EVENT: &str = "atelier:download-saved";
const SMOKE_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Default)]
struct Shell {
    runtime: Mutex<Option<Arc<Runtime>>>,
    /// Fixed for the server this shell attached to (see Runtime::stop).
    data_root: Mutex<Option<PathBuf>>,
    /// Server the window currently shows; None while the bundled local page is up.
    shown: Mutex<Option<Server>>,
    booting: AtomicBool,
    quitting: AtomicBool,
}

fn smoke_mode() -> bool {
    std::env::var("ATELIER_SMOKE").as_deref() == Ok("1")
}

/// Leave without the quit flow (smoke failures keep their exit code).
fn exit_now(app: &AppHandle, code: i32) {
    app.state::<Shell>().quitting.store(true, Ordering::SeqCst);
    app.exit(code);
}

fn local_page(app: &AppHandle, query: &[(&str, &str)]) -> Url {
    let base = if cfg!(windows) {
        "http://tauri.localhost/index.html"
    } else {
        "tauri://localhost/index.html"
    };
    let mut url = Url::parse(base).unwrap();
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("name", &app.package_info().name);
        for (key, value) in query {
            pairs.append_pair(key, value);
        }
    }
    url
}

fn server_url(server: &Server) -> Url {
    Url::parse(&format!("http://127.0.0.1:{}/", server.port)).unwrap()
}

fn is_local(url: &Url) -> bool {
    matches!(url.scheme(), "tauri" | "about" | "blob" | "data")
        || matches!(url.host_str(), Some("tauri.localhost") | Some("127.0.0.1"))
}

fn open_external(url: &str) {
    log(&format!("open externally: {url}"));
    #[cfg(target_os = "macos")]
    let _ = Command::new("open").arg(url).spawn();
    #[cfg(windows)]
    let _ = Command::new("explorer").arg(url).spawn();
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn navigate(app: &AppHandle, url: Url, server: Option<Server>) {
    *app.state::<Shell>().shown.lock().unwrap() = server;
    if let Some(window) = app.get_webview_window("main") {
        log(&format!("navigate {url}"));
        let _ = window.navigate(url);
    }
}

fn show_error(app: &AppHandle, message: &str) {
    navigate(app, local_page(app, &[("error", message)]), None);
    if smoke_mode() {
        log(&format!("smoke: failed: {message}"));
        exit_now(app, 1);
    }
}

fn seed_archive(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?.join("seed");
    log(&format!("looking for the seed in {}", dir.display()));
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("GameAtelier-"))
        })
}

fn prepare_runtime(app: &AppHandle) -> Result<Arc<Runtime>, String> {
    if let Some(existing) = app.state::<Shell>().runtime.lock().unwrap().clone() {
        return Ok(existing);
    }
    let root = match std::env::var_os("ATELIER_RUNTIME_ROOT") {
        // Development only: run against an already extracted bundle.
        Some(root) => PathBuf::from(root),
        None => {
            let local = app.path().local_data_dir().map_err(|e| e.to_string())?;
            let parent = runtime::runtime_parent(&local);
            let seed = seed_archive(app).ok_or("安装包里缺少运行环境")?;
            log(&format!(
                "seed {} ({:?})",
                seed.display(),
                runtime::seed_version(&seed)
            ));
            navigate(app, local_page(app, &[("stage", "preparing")]), None);
            runtime::prepare(&parent, &seed)?
        }
    };
    let runtime = Arc::new(Runtime { root });
    *app.state::<Shell>().runtime.lock().unwrap() = Some(runtime.clone());
    Ok(runtime)
}

/// Attach to the recorded server, or start one through the fixed launcher.
fn boot(app: AppHandle) {
    if app.state::<Shell>().booting.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(move || {
        let result = (|| -> Result<(Server, PathBuf), String> {
            let runtime = prepare_runtime(&app)?;
            navigate(&app, local_page(&app, &[]), None);
            let data_root = runtime.data_root()?;
            if let Some(server) = runtime::verified_server(&data_root) {
                log(&format!(
                    "attached to {server:?}, owned={}",
                    runtime::is_owned(&data_root, &server)
                ));
                return Ok((server, data_root));
            }
            runtime.start()?;
            // First start may have just written the platform data-root config.
            let data_root = runtime.data_root()?;
            let server =
                runtime::verified_server(&data_root).ok_or("服务启动后没有通过实例验证")?;
            runtime::mark_owned(&data_root, &server);
            log(&format!("started {server:?}"));
            Ok((server, data_root))
        })();
        let shell = app.state::<Shell>();
        match result {
            Ok((server, data_root)) => {
                *shell.data_root.lock().unwrap() = Some(data_root);
                navigate(&app, server_url(&server), Some(server));
            }
            Err(error) => show_error(&app, &error),
        }
        shell.booting.store(false, Ordering::SeqCst);
    });
}

fn watchdog(app: AppHandle) {
    thread::spawn(move || {
        let mut failures = 0;
        loop {
            thread::sleep(PROBE_INTERVAL);
            let shell = app.state::<Shell>();
            if shell.quitting.load(Ordering::SeqCst) {
                return;
            }
            let Some(shown) = shell.shown.lock().unwrap().clone() else {
                continue;
            };
            let Some(data_root) = shell.data_root.lock().unwrap().clone() else {
                continue;
            };
            let runtime = shell.runtime.lock().unwrap().clone();
            match runtime::verified_server(&data_root) {
                Some(server) if server == shown => failures = 0,
                Some(server) => {
                    // Restarted elsewhere (in-app update, another launcher): follow the record.
                    failures = 0;
                    log(&format!("server moved {shown:?} -> {server:?}"));
                    navigate(&app, server_url(&server), Some(server));
                }
                None if runtime.is_some_and(|r| r.update_in_progress(&data_root)) => failures = 0,
                None => {
                    failures += 1;
                    log(&format!("status probe failed ({failures})"));
                    if failures >= FAILED_PROBES_BEFORE_ERROR {
                        failures = 0;
                        show_error(&app, "服务已停止");
                    }
                }
            }
        }
    });
}

fn confirm_quit(app: &AppHandle, message: &str) -> bool {
    show_main(app);
    app.dialog()
        .message(message)
        .title(format!("退出 {}", app.package_info().name))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "仍然退出".into(),
            "取消".into(),
        ))
        .blocking_show()
}

/// Stop the server only if this shell started it; ask first while work is in flight.
fn quit(app: &AppHandle) {
    if app.state::<Shell>().quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        let shell = app.state::<Shell>();
        let runtime = shell.runtime.lock().unwrap().clone();
        let data_root = shell.data_root.lock().unwrap().clone();
        if let (Some(runtime), Some(data_root)) = (runtime, data_root) {
            match runtime::verified_server(&data_root) {
                Some(server) if runtime::is_owned(&data_root, &server) => {
                    let message = match runtime::active_work(&data_root, &server) {
                        Some(0) => None,
                        Some(n) => Some(format!("还有 {n} 项任务正在进行，退出会中断它们。")),
                        None => {
                            Some("无法确认是否有任务正在进行，退出会中断进行中的任务。".to_string())
                        }
                    };
                    if let Some(message) = message {
                        if !smoke_mode() && !confirm_quit(&app, &message) {
                            shell.quitting.store(false, Ordering::SeqCst);
                            return;
                        }
                    }
                    if let Err(error) = runtime.stop(&data_root) {
                        log(&format!("stop failed: {error}"));
                    }
                    runtime::clear_owned(&data_root);
                }
                Some(_) => log("server was not started by this shell; leaving it running"),
                None => {}
            }
        }
        app.exit(0);
    });
}

fn run_smoke(app: AppHandle) {
    // CI: boot, wait for the Atelier page, then go through the normal quit path.
    thread::spawn(move || {
        let started = Instant::now();
        while app.state::<Shell>().shown.lock().unwrap().is_none() {
            if started.elapsed() > SMOKE_TIMEOUT {
                log("smoke: timed out waiting for the server");
                exit_now(&app, 2);
                return;
            }
            thread::sleep(Duration::from_millis(500));
        }
        thread::sleep(Duration::from_secs(8));
        log("smoke: page shown, quitting");
        quit(&app);
    });
}

#[tauri::command]
fn retry(app: AppHandle) {
    boot(app);
}

#[tauri::command]
fn open_log(app: AppHandle) {
    let data_root = app.state::<Shell>().data_root.lock().unwrap().clone();
    if let Some(root) = data_root {
        open_external(&root.join(".runtime/server.log").to_string_lossy());
    } else if let Ok(local) = app.path().local_data_dir() {
        open_external(
            &runtime::runtime_parent(&local)
                .join("shell.log")
                .to_string_lossy(),
        );
    }
}

/// The only script the shell runs in the page: a documented event the page may listen to.
fn dispatch_download(webview: &tauri::Webview, path: &Path) {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let detail = serde_json::json!({ "name": name });
    let _ = webview.eval(format!(
        "window.dispatchEvent(new CustomEvent({}, {{ detail: {detail} }}))",
        serde_json::Value::from(DOWNLOAD_EVENT),
    ));
}

fn build_window(app: &tauri::App) -> tauri::Result<()> {
    let name = app.package_info().name.clone();
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title(&name)
        .inner_size(1440.0, 900.0)
        .min_inner_size(960.0, 600.0)
        // Let the page receive HTML5 file drops (Tauri intercepts them by default).
        .disable_drag_drop_handler()
        .on_page_load(|_window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                log(&format!("page loaded {}", payload.url()));
            }
        })
        .on_navigation(|url| {
            let local = is_local(url);
            if !local {
                open_external(url.as_str());
            }
            local
        })
        .on_new_window(|url, _features| {
            if is_local(&url) {
                log(&format!("blocked same-host new window {url}"));
            } else {
                open_external(url.as_str());
            }
            NewWindowResponse::Deny
        })
        .on_download(|webview, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    let name = destination
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "download".into());
                    let dir = webview
                        .app_handle()
                        .path()
                        .download_dir()
                        .unwrap_or_else(|_| std::env::temp_dir());
                    *destination = runtime::unique_download_path(&dir, &name);
                    log(&format!("download {url} -> {}", destination.display()));
                }
                DownloadEvent::Finished { path, success, .. } => {
                    log(&format!("download finished {path:?} success={success}"));
                    if let (true, Some(path)) = (success, path) {
                        dispatch_download(&webview, &path);
                    }
                }
                _ => {}
            }
            true
        })
        .build()?;
    Ok(())
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let name = app.package_info().name.clone();
    let show = MenuItem::with_id(app, "show", format!("显示 {name}"), true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", format!("退出 {name}"), true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit_item])?;
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip(&name)
        .menu(&menu)
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app)
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(Shell::default())
        .invoke_handler(tauri::generate_handler![retry, open_log])
        .setup(|app| {
            if let Ok(local) = app.path().local_data_dir() {
                runtime::runtime_parent(&local);
            }
            log(&format!(
                "{} {} starting",
                app.package_info().name,
                app.package_info().version
            ));
            build_window(app)?;
            build_tray(app)?;
            boot(app.handle().clone());
            watchdog(app.handle().clone());
            if smoke_mode() {
                run_smoke(app.handle().clone());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Closing keeps the server, running jobs and agent connections alive in the tray.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build the desktop shell");

    app.run(|app, event| match event {
        // ⌘Q, the app menu and the tray all go through the same quit flow.
        RunEvent::ExitRequested { api, .. }
            if !app.state::<Shell>().quitting.load(Ordering::SeqCst) =>
        {
            api.prevent_exit();
            quit(app);
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(app),
        _ => {}
    });
}
