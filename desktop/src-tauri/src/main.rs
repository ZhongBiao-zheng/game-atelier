// Desktop shell: a window, a tray icon and the viewer-server's lifetime. No business logic.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod menu;
mod runtime;

use runtime::{log, Runtime, Server};
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent},
    window::Color,
    AppHandle, LogicalSize, Manager, RunEvent, Theme, Url, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

const PROBE_INTERVAL: Duration = Duration::from_secs(3);
/// About nine seconds without an answer before the window reports a stopped server.
const FAILED_PROBES_BEFORE_ERROR: u32 = 3;
const DOWNLOAD_EVENT: &str = "atelier:download-saved";
const NAVIGATE_EVENT: &str = "atelier:navigate";
/// Height of the page's top bar (lg:h-20); the traffic lights sit centred in it.
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHTS: tauri::LogicalPosition<f64> = tauri::LogicalPosition { x: 20.0, y: 42.0 };
const WINDOW_STATE: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED);
/// Runs in the main frame before the page's own scripts; only on the Atelier page.
/// Marks the page as hosted by the shell (docs/contracts/desktop-shell.md) and drops the web
/// view's own context menu outside text fields and selections.
const PAGE_SCRIPT: &str = r#"(function () {
  if (location.hostname !== '127.0.0.1') return;
  var root = document.documentElement;
  root.dataset.shell = '__SHELL__';
  __TITLEBAR__
  document.addEventListener('contextmenu', function (event) {
    if (event.defaultPrevented) return;
    var target = event.target;
    if (target instanceof Element && target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
    var selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    event.preventDefault();
  });
})();"#;
const SMOKE_TIMEOUT: Duration = Duration::from_secs(180);
/// Extra time for a first start after the launcher's own 8 s check has given up.
const SLOW_START_GRACE: Duration = Duration::from_secs(30);

#[derive(Default)]
struct Shell {
    runtime: Mutex<Option<Arc<Runtime>>>,
    /// Fixed for the server this shell attached to (see Runtime::stop).
    data_root: Mutex<Option<PathBuf>>,
    /// Server the window currently shows; None while the bundled local page is up.
    shown: Mutex<Option<Server>>,
    booting: AtomicBool,
    quitting: AtomicBool,
    /// Set once the seed was unpacked by this launch (a first start).
    unpacked: AtomicBool,
    /// Milliseconds since UNIX_EPOCH of the last progress pushed to the loading page.
    progress_at: AtomicU64,
    /// The URL the window was last sent to, and whether it is still loading (see `navigate`).
    current_url: Mutex<Option<Url>>,
    loading: AtomicBool,
    /// `<local data>/game-atelier/runtime`: shell log and the remembered window theme.
    runtime_parent: Mutex<Option<PathBuf>>,
}

/// What the error page shows. `detail` is only ever a reason the launcher wrote for users.
struct Failure {
    kind: &'static str,
    detail: String,
}

impl Failure {
    fn new(kind: &'static str, detail: String) -> Self {
        Failure { kind, detail }
    }
}

fn smoke_mode() -> bool {
    std::env::var("ATELIER_SMOKE").as_deref() == Ok("1")
}

/// Leave without the quit flow (smoke failures keep their exit code).
fn exit_now(app: &AppHandle, code: i32) {
    app.state::<Shell>().quitting.store(true, Ordering::SeqCst);
    app.exit(code);
}

fn theme_name(app: &AppHandle) -> &'static str {
    let parent = app.state::<Shell>().runtime_parent.lock().unwrap().clone();
    match parent.and_then(|p| runtime::saved_theme(&p)).as_deref() {
        Some("light") => "light",
        _ => "dark",
    }
}

fn background(theme: &str) -> Color {
    // --background in web/src/styles/tokens.css (dark / light).
    if theme == "light" {
        Color(0xF2, 0xF2, 0xF3, 0xFF)
    } else {
        Color(0x0A, 0x0A, 0x0B, 0xFF)
    }
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
        pairs.append_pair("theme", theme_name(app));
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

/// Longest wait for the current page to finish loading before replacing it.
const LOAD_SETTLE: Duration = Duration::from_secs(2);

/// Navigating away while the bundled page (tauri://) is still being served makes wry answer a
/// request WebKit has already cancelled, which aborts the whole process. So: never re-load the
/// page that is already shown, and let a loading page finish first. Never called on the main
/// thread (boot, watchdog and quit threads only), so the short wait blocks nothing visible.
fn navigate(app: &AppHandle, url: Url, server: Option<Server>) {
    let shell = app.state::<Shell>();
    // The server page is always reloaded: after an in-app update it is a new instance on the same URL.
    let bundled_page = server.is_none();
    *shell.shown.lock().unwrap() = server;
    if bundled_page && shell.current_url.lock().unwrap().as_ref() == Some(&url) {
        return;
    }
    let started = Instant::now();
    while shell.loading.load(Ordering::SeqCst) && started.elapsed() < LOAD_SETTLE {
        thread::sleep(Duration::from_millis(20));
    }
    *shell.current_url.lock().unwrap() = Some(url.clone());
    shell.loading.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        log(&format!("navigate {url}"));
        let _ = window.navigate(url);
    }
}

fn show_error(app: &AppHandle, failure: &Failure) {
    let mut query = vec![("error", failure.kind)];
    if !failure.detail.is_empty() {
        query.push(("detail", failure.detail.as_str()));
    }
    navigate(app, local_page(app, &query), None);
    if smoke_mode() {
        log(&format!(
            "smoke: failed: {} {}",
            failure.kind, failure.detail
        ));
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

fn prepare_runtime(app: &AppHandle) -> Result<Arc<Runtime>, Failure> {
    prepare_runtime_inner(app).map_err(|error| {
        log(&format!("runtime not ready: {error}"));
        Failure::new("install", String::new())
    })
}

fn prepare_runtime_inner(app: &AppHandle) -> Result<Arc<Runtime>, String> {
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
            let shell = app.state::<Shell>();
            // The page never asks for progress: a request still in flight when the window
            // navigates away aborts the web view's IPC (seen as a crash at start-up). The shell
            // pushes it instead, and only shows the unpacking page when it really unpacks.
            runtime::prepare(&parent, &seed, &|done, total| {
                if !shell.unpacked.swap(true, Ordering::SeqCst) {
                    navigate(app, local_page(app, &[("stage", "preparing")]), None);
                }
                let now = runtime::now_millis();
                if now.saturating_sub(shell.progress_at.load(Ordering::Relaxed)) < 100 {
                    return;
                }
                shell.progress_at.store(now, Ordering::Relaxed);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval(format!(
                        "window.atelierProgress && window.atelierProgress({done}, {total})"
                    ));
                }
            })?
        }
    };
    let runtime = Arc::new(Runtime { root });
    *app.state::<Shell>().runtime.lock().unwrap() = Some(runtime.clone());
    Ok(runtime)
}

fn wait_for_server(data_root: &Path) -> Option<Server> {
    let started = Instant::now();
    loop {
        if let Some(server) = runtime::verified_server(data_root) {
            return Some(server);
        }
        if started.elapsed() > SLOW_START_GRACE {
            return None;
        }
        thread::sleep(Duration::from_millis(500));
    }
}

/// Attach to the recorded server, or start one through the fixed launcher.
fn boot(app: AppHandle) {
    if app.state::<Shell>().booting.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(move || {
        let result = (|| -> Result<(Server, PathBuf), Failure> {
            let runtime = prepare_runtime(&app)?;
            // A runtime unpacked just now still has to pass the system's first-load checks.
            let unpacked = app.state::<Shell>().unpacked.load(Ordering::SeqCst);
            let stage: &[(&str, &str)] = if unpacked { &[("stage", "first")] } else { &[] };
            navigate(&app, local_page(&app, stage), None);
            let start_failed = |detail: String| Failure::new("start", detail);
            let data_root = runtime.data_root().map_err(start_failed)?;
            if let Some(server) = runtime::verified_server(&data_root) {
                log(&format!(
                    "attached to {server:?}, owned={}",
                    runtime::is_owned(&data_root, &server)
                ));
                return Ok((server, data_root));
            }
            let started = runtime.start();
            // The launcher reports the data root it started with (first start writes the config).
            let data_root = match &started {
                Ok(root) => root.clone(),
                Err(_) => runtime.data_root().map_err(start_failed)?,
            };
            // The launcher gives up after 8 s, but a freshly unpacked runtime waits on the system's
            // first-load check of every native library: wait for the record instead of failing.
            let server = wait_for_server(&data_root).ok_or_else(|| {
                log("no verified server after the grace period");
                start_failed(started.err().unwrap_or_default())
            })?;
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
            Err(failure) => show_error(&app, &failure),
        }
        shell.booting.store(false, Ordering::SeqCst);
    });
}

/// The page sets the window theme (set_theme) but no event reports it, so the shell reads it
/// back: the next start opens with the same background and loading page colours.
fn remember_theme(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(theme) = window.theme() else {
        return;
    };
    let name = if theme == Theme::Light {
        "light"
    } else {
        "dark"
    };
    if theme_name(app) == name {
        return;
    }
    if let Some(parent) = app.state::<Shell>().runtime_parent.lock().unwrap().clone() {
        runtime::save_theme(&parent, name);
    }
    let _ = window.set_background_color(Some(background(name)));
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
            remember_theme(&app);
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
                    // An update restarts our server as a new instance; it is still ours to stop.
                    if runtime::is_owned(&data_root, &shown) {
                        runtime::mark_owned(&data_root, &server);
                    }
                    navigate(&app, server_url(&server), Some(server));
                }
                None if runtime.is_some_and(|r| r.update_in_progress(&data_root)) => failures = 0,
                None => {
                    failures += 1;
                    log(&format!("status probe failed ({failures})"));
                    if failures >= FAILED_PROBES_BEFORE_ERROR {
                        failures = 0;
                        show_error(&app, &Failure::new("stopped", String::new()));
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
    remember_theme(app);
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
    // CI: boot, wait for the server page, then go through the normal quit path.
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

/// A documented event the page may listen to (docs/contracts/desktop-shell.md).
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

/// First-run size: 1440×900, or 85 % of a smaller screen. Later runs restore the saved state.
fn initial_size(app: &tauri::App) -> LogicalSize<f64> {
    let screen = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.size().to_logical::<f64>(m.scale_factor()));
    match screen {
        Some(s) => LogicalSize::new((s.width * 0.85).min(1440.0), (s.height * 0.85).min(900.0)),
        None => LogicalSize::new(1440.0, 900.0),
    }
}

/// Pages older than this shell leave no room for the traffic lights, so they keep the system title
/// bar. Decided once, before the window exists: Tauri cannot switch the style of a live window
/// reliably (the web view went blank in testing). The seed always matches the shell, so only an
/// older runtime kept from a previous install gets the system title bar.
fn overlay_title_bar(app: &tauri::App) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    let parent = app.state::<Shell>().runtime_parent.lock().unwrap().clone();
    let installed = parent.and_then(|p| runtime::installed_version(&runtime::runtime_root(&p)));
    let shell = app.package_info().version.to_string();
    installed.is_none_or(|v| runtime::at_least(&v, &shell))
}

fn page_script(overlay: bool) -> String {
    let shell = if cfg!(target_os = "macos") {
        "macos"
    } else {
        "windows"
    };
    let titlebar = if overlay {
        "root.dataset.titlebar = 'overlay';"
    } else {
        ""
    };
    PAGE_SCRIPT
        .replace("__SHELL__", shell)
        .replace("__TITLEBAR__", titlebar)
}

fn build_window(app: &tauri::App) -> tauri::Result<()> {
    let name = app.package_info().name.clone();
    let theme = theme_name(app.handle());
    let size = initial_size(app);
    let overlay = overlay_title_bar(app);
    log(&format!("title bar overlay={overlay}"));
    // The loading page from the first frame, in the remembered theme.
    let first_url = local_page(app.handle(), &[]);
    let shell = app.state::<Shell>();
    *shell.current_url.lock().unwrap() = Some(first_url.clone());
    shell.loading.store(true, Ordering::SeqCst);
    let first_page = WebviewUrl::CustomProtocol(first_url);
    let builder = WebviewWindowBuilder::new(app, "main", first_page)
        .title(&name)
        .inner_size(size.width, size.height)
        // At lg (1024 px) the page's top bar is one row; the traffic lights are centred on it.
        .min_inner_size(1024.0, 640.0)
        .center()
        .theme(Some(if theme == "light" {
            Theme::Light
        } else {
            Theme::Dark
        }))
        .background_color(background(theme))
        .initialization_script(page_script(overlay))
        // Let the page receive HTML5 file drops (Tauri intercepts them by default).
        .disable_drag_drop_handler();
    #[cfg(target_os = "macos")]
    let builder = if overlay {
        builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(TRAFFIC_LIGHTS)
    } else {
        builder
    }
    .allow_link_preview(false);
    builder
        .on_page_load(|window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                log(&format!("page loaded {}", payload.url()));
                window
                    .app_handle()
                    .state::<Shell>()
                    .loading
                    .store(false, Ordering::SeqCst);
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

fn handle_menu(app: &AppHandle, id: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    match id {
        menu::SETTINGS => {
            show_main(app);
            if app.state::<Shell>().shown.lock().unwrap().is_some() {
                let detail = serde_json::json!({ "path": "/settings/providers" });
                let _ = window.eval(format!(
                    "window.dispatchEvent(new CustomEvent({}, {{ detail: {detail} }}))",
                    serde_json::Value::from(NAVIGATE_EVENT),
                ));
            }
        }
        menu::RELOAD => {
            let _ = window.reload();
        }
        menu::ACTUAL_SIZE => {
            let _ = window.set_zoom(1.0);
        }
        menu::OPEN_LOG => open_log(app.clone()),
        _ => {}
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let name = app.package_info().name.clone();
    let show = MenuItem::with_id(app, "show", format!("显示 {name}"), true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", format!("退出 {name}"), true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit_item])?;
    // macOS: the bare glyph as a template image (the app icon's backplate disappears into the
    // menu bar and leaves a 9 px squiggle); scripts/build_tray_icon.py makes it.
    #[cfg(target_os = "macos")]
    let icon = tauri::image::Image::from_bytes(include_bytes!(
        "../../../assets/brand/atelier-tray-template.png"
    ))?;
    #[cfg(not(target_os = "macos"))]
    let icon = app.default_window_icon().unwrap().clone();
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
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
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(WINDOW_STATE)
                .build(),
        )
        .manage(Shell::default())
        .invoke_handler(tauri::generate_handler![retry, open_log])
        .setup(|app| {
            if let Ok(local) = app.path().local_data_dir() {
                let parent = runtime::runtime_parent(&local);
                *app.state::<Shell>().runtime_parent.lock().unwrap() = Some(parent);
            }
            log(&format!(
                "{} {} starting",
                app.package_info().name,
                app.package_info().version
            ));
            app.set_menu(menu::build(app.handle())?)?;
            app.on_menu_event(|app, event| handle_menu(app, event.id().as_ref()));
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
                let _ = window.app_handle().save_window_state(WINDOW_STATE);
                remember_theme(window.app_handle());
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
