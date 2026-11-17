//! The system menu bar. Clipboard and window items are the system's own (`PredefinedMenuItem`),
//! so they act on the focused text field exactly as in any Mac app; the page sees key presses
//! first and keeps its own shortcuts (canvas undo, select all).

use tauri::{
    menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Runtime,
};

pub const SETTINGS: &str = "settings";
pub const RELOAD: &str = "reload";
pub const ACTUAL_SIZE: &str = "actual-size";
pub const OPEN_LOG: &str = "open-log";
pub const QUIT: &str = "quit-app";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let name = app.package_info().name.clone();
    let about = AboutMetadata {
        name: Some(name.clone()),
        version: Some(app.package_info().version.to_string()),
        icon: app.default_window_icon().cloned(),
        ..Default::default()
    };
    let separator = || PredefinedMenuItem::separator(app);
    let app_menu = Submenu::with_items(
        app,
        &name,
        true,
        &[
            &PredefinedMenuItem::about(app, Some(&format!("关于 {name}")), Some(about))?,
            &separator()?,
            &MenuItem::with_id(app, SETTINGS, "设置…", true, Some("CmdOrCtrl+,"))?,
            &separator()?,
            &PredefinedMenuItem::hide(app, Some(&format!("隐藏 {name}")))?,
            &PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?,
            &PredefinedMenuItem::show_all(app, Some("全部显示"))?,
            &separator()?,
            // Not the predefined Quit: that terminates the app on the spot and skips the shell's quit
            // flow (stop the server it started, ask first while work is running).
            &MenuItem::with_id(app, QUIT, format!("退出 {name}"), true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("撤销"))?,
            &PredefinedMenuItem::redo(app, Some("重做"))?,
            &separator()?,
            &PredefinedMenuItem::cut(app, Some("剪切"))?,
            &PredefinedMenuItem::copy(app, Some("拷贝"))?,
            &PredefinedMenuItem::paste(app, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(app, Some("全选"))?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "显示",
        true,
        &[
            &MenuItem::with_id(app, RELOAD, "重新载入", true, Some("CmdOrCtrl+R"))?,
            &MenuItem::with_id(app, ACTUAL_SIZE, "实际大小", true, Some("CmdOrCtrl+0"))?,
            &separator()?,
            &PredefinedMenuItem::fullscreen(app, Some("进入全屏幕"))?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("最小化"))?,
            &PredefinedMenuItem::maximize(app, Some("缩放"))?,
            &separator()?,
            &PredefinedMenuItem::close_window(app, Some("关闭窗口"))?,
        ],
    )?;
    let help = Submenu::with_items(
        app,
        "帮助",
        true,
        &[&MenuItem::with_id(
            app,
            OPEN_LOG,
            "查看日志",
            true,
            None::<&str>,
        )?],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &view, &window, &help])
}
