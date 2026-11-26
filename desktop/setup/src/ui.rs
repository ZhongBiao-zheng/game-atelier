//! The installer window: a borderless tao window holding a WebView2 page (`ui/index.html`).
//! The page owns the visuals; this side owns every step that touches the system.

use crate::{
    install::{self, Plan},
    payload::{Payload, Role},
    system,
    takeover::Earlier,
};
use serde_json::{json, Value};
use std::{
    borrow::Cow,
    path::{Path, PathBuf},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
use tao::{
    dpi::{LogicalSize, PhysicalPosition},
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy},
    platform::{
        run_return::EventLoopExtRunReturn,
        windows::{IconExtWindows, WindowBuilderExtWindows, WindowExtWindows},
    },
    window::{Icon, WindowBuilder},
};
use wry::{
    http::{header::CONTENT_TYPE, Request, Response},
    WebContext, WebViewBuilder,
};

const WIDTH: f64 = 640.0;
const HEIGHT: f64 = 420.0;
const PAGE: &str = include_str!("../ui/index.html");
const MARK: &str = include_str!("../../../assets/brand/atelier-mark.svg");
const INTER: &[u8] = include_bytes!("../ui/fonts/inter-latin-wght-normal.woff2");
const SERIF: &[u8] = include_bytes!("../ui/fonts/instrument-serif-latin-400-normal.woff2");
/// Progress pushed to the page at most this often.
const PROGRESS_EVERY: Duration = Duration::from_millis(80);

pub struct Context {
    pub payload: Payload,
    /// Install: where to install (the existing install's folder on an update). Uninstall: the
    /// folder being removed.
    pub dir: PathBuf,
    pub existing_version: Option<String>,
    /// Install: an install under an earlier product name this one takes over.
    pub earlier: Option<Earlier>,
    /// CI screenshots: render one state, act on nothing.
    pub preview: Option<String>,
    /// CI: start right away, as if the main button had been clicked.
    pub auto: bool,
}

enum UserEvent {
    Command(Value),
    Eval(String),
    Show,
}

fn theme() -> &'static str {
    match std::fs::read_to_string(install::runtime_parent().join("window-theme")) {
        Ok(theme) if theme.trim() == "light" => "light",
        _ => "dark",
    }
}

fn asset(path: &str) -> Option<(&'static [u8], &'static str)> {
    Some(match path {
        "/" | "/index.html" => (PAGE.as_bytes(), "text/html; charset=utf-8"),
        "/mark.svg" => (MARK.as_bytes(), "image/svg+xml"),
        "/fonts/inter-latin-wght-normal.woff2" => (INTER, "font/woff2"),
        "/fonts/instrument-serif-latin-400-normal.woff2" => (SERIF, "font/woff2"),
        _ => return None,
    })
}

fn serve(request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    match asset(request.uri().path()) {
        Some((body, mime)) => Response::builder()
            .header(CONTENT_TYPE, mime)
            .body(Cow::Borrowed(body))
            .unwrap(),
        None => Response::builder()
            .status(404)
            .body(Cow::Borrowed(&[][..]))
            .unwrap(),
    }
}

fn js_call(function: &str, arg: Value) -> String {
    format!("window.setup && window.setup.{function}({arg})")
}

fn eval(proxy: &EventLoopProxy<UserEvent>, function: &str, arg: Value) {
    let _ = proxy.send_event(UserEvent::Eval(js_call(function, arg)));
}

/// Run one step on a worker thread: busy state, throttled progress, then done state or failure.
fn run_step(
    proxy: EventLoopProxy<UserEvent>,
    busy_state: &'static str,
    done_state: &'static str,
    step: impl FnOnce(&mut dyn FnMut(f64)) -> Result<(), String> + Send + 'static,
) {
    eval(&proxy, "show", json!(busy_state));
    thread::spawn(move || {
        let mut last = Instant::now() - PROGRESS_EVERY;
        let progress_proxy = proxy.clone();
        let mut report = move |fraction: f64| {
            if fraction < 1.0 && last.elapsed() < PROGRESS_EVERY {
                return;
            }
            last = Instant::now();
            eval(&progress_proxy, "progress", json!(fraction));
        };
        match step(&mut report) {
            Ok(()) => eval(&proxy, "show", json!(done_state)),
            Err(reason) => {
                install::log(&format!("failed: {reason}"));
                eval(&proxy, "fail", json!(reason));
            }
        }
    });
}

/// The folder an install command targets (from the page's plan), else the context's folder.
fn plan_dir(command: &Value, fallback: &Path) -> PathBuf {
    command["plan"]["dir"]
        .as_str()
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| fallback.to_path_buf())
}

/// Install or uninstall, after making sure the app is not running from that folder.
fn start(proxy: &EventLoopProxy<UserEvent>, payload: &Arc<Payload>, step: &str, plan: Plan) {
    if install::plan_running(&plan) {
        eval(proxy, "show", json!("running"));
        return;
    }
    let payload = payload.clone();
    if step == "install" {
        run_step(proxy.clone(), "installing", "done", move |report| {
            install::install(&payload, &plan, report)
        });
    } else {
        run_step(
            proxy.clone(),
            "uninstalling",
            "uninstalled",
            move |report| install::uninstall(&payload.manifest, &plan.dir, report),
        );
    }
}

fn plan_for(command: &Value, step: &str, context_dir: &Path, earlier: &Option<Earlier>) -> Plan {
    let install = step == "install";
    Plan {
        dir: if install {
            plan_dir(command, context_dir)
        } else {
            context_dir.to_path_buf()
        },
        desktop_shortcut: command["plan"]["desktop"].as_bool().unwrap_or(true),
        earlier: if install { earlier.clone() } else { None },
    }
}

/// WebView2 keeps a profile folder; by default it would land next to the setup exe (Downloads).
pub fn webview_data_dir() -> PathBuf {
    std::env::temp_dir().join("atelier-setup-webview2")
}

pub fn run(ctx: Context) -> i32 {
    let payload = Arc::new(ctx.payload);
    let product = payload.manifest.product.clone();
    let mut role = payload.manifest.role;
    let mut preview = ctx.preview;
    let mut existing_version = ctx.existing_version;
    // Previews of the uninstaller and update screens, rendered by the installer exe.
    match preview.as_deref() {
        Some("confirm" | "uninstalling" | "uninstalled") => role = Role::Uninstall,
        Some("update") => {
            preview = Some("welcome".into());
            existing_version = Some("5.138.0".into());
        }
        _ => {}
    }

    let mut event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let title = match role {
        Role::Install => product.clone(),
        Role::Uninstall => format!("卸载 {product}"),
    };
    let mut builder = WindowBuilder::new()
        .with_title(title)
        .with_inner_size(LogicalSize::new(WIDTH, HEIGHT))
        .with_resizable(false)
        .with_maximizable(false)
        .with_decorations(false)
        .with_undecorated_shadow(true)
        .with_visible(false)
        .with_window_icon(Icon::from_resource(1, None).ok());
    if let Some(monitor) = event_loop.primary_monitor() {
        let scale = monitor.scale_factor();
        let (size, origin) = (monitor.size(), monitor.position());
        builder = builder.with_position(PhysicalPosition::new(
            origin.x + ((size.width as f64 - WIDTH * scale) / 2.0) as i32,
            origin.y + ((size.height as f64 - HEIGHT * scale) / 2.0) as i32,
        ));
    }
    let window = match builder.build(&event_loop) {
        Ok(window) => window,
        Err(e) => {
            system::alert(&product, &format!("无法打开窗口：{e}"));
            return 1;
        }
    };
    system::round_corners(window.hwnd());

    let theme = theme();
    let state = json!({
        "role": if role == Role::Uninstall { "uninstall" } else { "install" },
        "product": product,
        "version": payload.manifest.version,
        "dir": ctx.dir.display().to_string(),
        "existingVersion": existing_version,
        "theme": theme,
        "preview": preview,
        "auto": ctx.auto,
    });
    let background = if theme == "light" {
        (0xF2, 0xF2, 0xF3, 0xFF)
    } else {
        (0x0A, 0x0A, 0x0B, 0xFF)
    };
    let mut web_context = WebContext::new(Some(webview_data_dir()));
    let ipc_proxy = proxy.clone();
    let built = WebViewBuilder::new_with_web_context(&mut web_context)
        .with_background_color(background)
        .with_initialization_script(format!("window.__SETUP__ = {state};"))
        .with_custom_protocol("setup".into(), |_id, request| serve(request))
        // WebView2 serves custom protocols as http://<scheme>.<host>/.
        .with_url("http://setup.localhost/index.html")
        .with_devtools(false)
        .with_ipc_handler(move |request: Request<String>| {
            if let Ok(command) = serde_json::from_str::<Value>(request.body()) {
                let _ = ipc_proxy.send_event(UserEvent::Command(command));
            }
        })
        .build(&window);
    let webview = match built {
        Ok(webview) => webview,
        Err(e) => {
            system::alert(&product, &format!("无法打开安装界面：{e}"));
            return 1;
        }
    };
    // Shown once the page reports ready, or after a short wait whatever happens.
    let show_proxy = proxy.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(3));
        let _ = show_proxy.send_event(UserEvent::Show);
    });

    let context_dir = ctx.dir;
    let earlier = ctx.earlier;
    let is_preview = preview.is_some();
    let mut shown = false;
    // run_return, not run: the caller still cleans up after the window closes.
    event_loop.run_return(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        let _keep_alive = &web_context;
        let command = match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                *control_flow = ControlFlow::ExitWithCode(0);
                return;
            }
            Event::UserEvent(UserEvent::Show) => {
                if !shown {
                    shown = true;
                    window.set_visible(true);
                    window.set_focus();
                }
                return;
            }
            Event::UserEvent(UserEvent::Eval(script)) => {
                let _ = webview.evaluate_script(&script);
                return;
            }
            Event::UserEvent(UserEvent::Command(command)) => command,
            _ => return,
        };
        let cmd = command["cmd"].as_str().unwrap_or_default();
        match cmd {
            "ready" => {
                let _ = proxy.send_event(UserEvent::Show);
            }
            "drag" => {
                let _ = window.drag_window();
            }
            "minimize" => window.set_minimized(true),
            "exit" => *control_flow = ControlFlow::ExitWithCode(0),
            _ if is_preview => {}
            "browse" => {
                let picked = rfd::FileDialog::new()
                    .set_title("选择安装位置")
                    .set_parent(&window)
                    .pick_folder();
                if let Some(picked) = picked {
                    let resolved = install::resolve_dir(&picked, &product);
                    let script = js_call("dir", json!(resolved.display().to_string()));
                    let _ = webview.evaluate_script(&script);
                }
            }
            "install" | "uninstall" => {
                let plan = plan_for(&command, cmd, &context_dir, &earlier);
                start(&proxy, &payload, cmd, plan);
            }
            "quit-app" => {
                let step = command["then"].as_str().unwrap_or("install").to_string();
                let plan = plan_for(&command, &step, &context_dir, &earlier);
                let (proxy, payload, product) = (proxy.clone(), payload.clone(), product.clone());
                thread::spawn(move || {
                    if install::quit_plan(&plan, &payload.manifest.main) {
                        start(&proxy, &payload, &step, plan);
                    } else {
                        let reason = format!("{product} 没有退出，请从任务栏通知区域退出后重试");
                        eval(&proxy, "fail", json!(reason));
                    }
                });
            }
            "launch" => {
                let dir = plan_dir(&command, &context_dir);
                let exe = install::app_exe(&dir, &payload.manifest.main);
                if let Err(e) = std::process::Command::new(&exe).current_dir(&dir).spawn() {
                    install::log(&format!("launch failed: {e}"));
                }
                *control_flow = ControlFlow::ExitWithCode(0);
            }
            _ => {}
        }
    })
}
