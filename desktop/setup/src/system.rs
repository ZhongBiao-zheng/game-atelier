//! Thin wrappers over the Windows APIs the installer needs.

use std::{
    ffi::OsString,
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
};
use windows::{
    core::{Interface, GUID, HSTRING, PCWSTR, PWSTR},
    Win32::{
        Foundation::{CloseHandle, HWND, PROPERTYKEY},
        Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND},
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, IPersistFile,
                StructuredStorage::{
                    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
                },
                CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
            },
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, TerminateProcess, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
            },
            Variant::VT_LPWSTR,
        },
        UI::{
            Shell::{
                FOLDERID_Desktop, FOLDERID_Programs, IShellLinkW, PropertiesSystem::IPropertyStore,
                SHGetKnownFolderPath, ShellLink, KF_FLAG_DEFAULT,
            },
            WindowsAndMessaging::{
                MessageBoxW, IDOK, MB_ICONERROR, MB_ICONINFORMATION, MB_OKCANCEL,
            },
        },
    },
};

/// Same key the shell's Tauri runtime reads for WebView2 (Evergreen runtime client id).
const WEBVIEW2_CLIENT: &str =
    r"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

fn lower(path: &Path) -> String {
    path.to_string_lossy().to_lowercase().replace('/', "\\")
}

/// Whether `path` is `dir` or lies inside it (case-insensitive, as NTFS paths are).
pub fn is_within(path: &Path, dir: &Path) -> bool {
    let (path, dir) = (lower(path), lower(dir));
    let dir = dir.trim_end_matches('\\');
    path == dir || path.starts_with(&format!("{dir}\\"))
}

/// Running processes whose executable lies under `dir`: `(pid, exe path)`.
pub fn processes_under(dir: &Path) -> Vec<(u32, PathBuf)> {
    let mut found = Vec::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return found;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
        while more {
            if let Some(path) = process_path(entry.th32ProcessID) {
                if is_within(&path, dir) {
                    found.push((entry.th32ProcessID, path));
                }
            }
            more = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
    }
    found
}

fn process_path(pid: u32) -> Option<PathBuf> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(handle);
        result.ok()?;
        Some(PathBuf::from(OsString::from_wide(&buf[..len as usize])))
    }
}

pub fn terminate(pid: u32) {
    unsafe {
        if let Ok(handle) = OpenProcess(PROCESS_TERMINATE, false, pid) {
            let _ = TerminateProcess(handle, 1);
            let _ = CloseHandle(handle);
        }
    }
}

fn known_folder(id: &windows::core::GUID) -> Option<PathBuf> {
    unsafe {
        let raw = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
        let path = PathBuf::from(OsString::from_wide(raw.as_wide()));
        CoTaskMemFree(Some(raw.0 as _));
        Some(path)
    }
}

/// Start menu programs folder (follows folder redirection).
pub fn programs_dir() -> Option<PathBuf> {
    known_folder(&FOLDERID_Programs)
}

/// The desktop, wherever it was redirected to (OneDrive included).
pub fn desktop_dir() -> Option<PathBuf> {
    known_folder(&FOLDERID_Desktop)
}

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

/// System.AppUserModel.ID (propkey.h).
const PKEY_APP_USER_MODEL_ID: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
    pid: 5,
};

/// Set the shortcut's AppUserModelID (a VT_LPWSTR the store copies before we drop the buffer).
fn set_app_user_model_id(shell_link: &IShellLinkW, app_id: &str) -> Result<(), String> {
    let mut value: Vec<u16> = app_id.encode_utf16().chain(Some(0)).collect();
    let variant = PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_LPWSTR,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: PROPVARIANT_0_0_0 {
                    pwszVal: PWSTR(value.as_mut_ptr()),
                },
            }),
        },
    };
    unsafe {
        let store: IPropertyStore = shell_link.cast().map_err(|e| e.to_string())?;
        store
            .SetValue(&PKEY_APP_USER_MODEL_ID, &variant)
            .and_then(|()| store.Commit())
            .map_err(|e| format!("无法写入快捷方式的应用标识：{e}"))
    }
}

/// Create or replace a `.lnk` pointing at `target`, carrying `app_id` when there is one.
pub fn create_shortcut(link: &Path, target: &Path, app_id: &str) -> Result<(), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let shell_link: IShellLinkW =
            CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
        let target_w = wide(target);
        shell_link
            .SetPath(PCWSTR(target_w.as_ptr()))
            .map_err(|e| e.to_string())?;
        if let Some(dir) = target.parent() {
            let dir_w = wide(dir);
            shell_link
                .SetWorkingDirectory(PCWSTR(dir_w.as_ptr()))
                .map_err(|e| e.to_string())?;
        }
        shell_link
            .SetIconLocation(PCWSTR(target_w.as_ptr()), 0)
            .map_err(|e| e.to_string())?;
        if !app_id.is_empty() {
            set_app_user_model_id(&shell_link, app_id)?;
        }
        let file: IPersistFile = shell_link.cast().map_err(|e| e.to_string())?;
        file.Save(&HSTRING::from(link.as_os_str()), true)
            .map_err(|e| format!("无法创建快捷方式 {}：{e}", link.display()))
    }
}

/// Whether the Evergreen WebView2 runtime is installed (per machine or per user).
pub fn webview2_installed() -> bool {
    use winreg::{enums::*, RegKey};
    let machine = RegKey::predef(HKEY_LOCAL_MACHINE);
    let user = RegKey::predef(HKEY_CURRENT_USER);
    [
        machine.open_subkey(format!(r"SOFTWARE\WOW6432Node\{WEBVIEW2_CLIENT}")),
        machine.open_subkey(format!(r"SOFTWARE\{WEBVIEW2_CLIENT}")),
        user.open_subkey(format!(r"Software\{WEBVIEW2_CLIENT}")),
    ]
    .into_iter()
    .flatten()
    .filter_map(|key| key.get_value::<String, _>("pv").ok())
    .any(|version| !version.is_empty() && version != "0.0.0.0")
}

/// Windows 11 rounds the corners of a borderless window only when asked to.
pub fn round_corners(hwnd: isize) {
    unsafe {
        let preference = DWMWCP_ROUND;
        let _ = DwmSetWindowAttribute(
            HWND(hwnd as _),
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &preference as *const _ as _,
            std::mem::size_of_val(&preference) as u32,
        );
    }
}

/// A native message for the cases that happen before the window exists.
pub fn alert(title: &str, text: &str) {
    unsafe {
        MessageBoxW(
            None,
            &HSTRING::from(text),
            &HSTRING::from(title),
            MB_ICONERROR,
        );
    }
}

pub fn confirm(title: &str, text: &str) -> bool {
    unsafe {
        MessageBoxW(
            None,
            &HSTRING::from(text),
            &HSTRING::from(title),
            MB_OKCANCEL | MB_ICONINFORMATION,
        ) == IDOK
    }
}
