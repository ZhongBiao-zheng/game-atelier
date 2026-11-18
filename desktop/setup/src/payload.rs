//! What `scripts/build_desktop.py` appends to this exe: the files to install and a manifest.
//!
//! Layout: `<setup exe> <file bytes…> <manifest JSON> <u64 LE manifest length> <MAGIC>`. The
//! uninstaller is the same exe with an empty file list, `role: uninstall`, and the list of paths
//! it installed.
//!
//! The installer knows nothing about how the app was built: every entry is a file to put in the
//! install folder at its path, except entries under `setup/`, which are for the installer itself.

use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

const MAGIC: &[u8; 8] = b"ATELPAY1";
const TRAILER: u64 = 16;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Install,
    Uninstall,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Entry {
    /// Path inside the install directory, `/`-separated.
    pub path: String,
    pub offset: u64,
    pub size: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Manifest {
    pub role: Role,
    pub product: String,
    pub version: String,
    /// The app's main program, relative to the install folder (shortcuts, launch, Apps entry).
    pub main: String,
    /// Length of the setup exe itself, before any payload.
    pub exe_len: u64,
    pub files: Vec<Entry>,
    /// Uninstaller only: what the installer put in the install folder.
    #[serde(default)]
    pub installed: Vec<String>,
}

/// Entries under this prefix are for the installer (the WebView2 bootstrapper), never installed.
pub const SETUP_ONLY: &str = "setup/";

pub struct Payload {
    pub manifest: Manifest,
    source: PathBuf,
}

const INCOMPLETE: &str = "安装程序不完整，请重新下载";

/// Next to `dest` but never matching `GameAtelier-*` (the shell picks the seed by that prefix).
fn partial_path(dest: &Path) -> PathBuf {
    let name = dest.file_name().unwrap_or_default().to_string_lossy();
    dest.with_file_name(format!(".{name}.partial"))
}

impl Payload {
    pub fn read_self() -> Result<Payload, String> {
        let source = std::env::current_exe().map_err(|e| e.to_string())?;
        let mut file = File::open(&source).map_err(|e| e.to_string())?;
        let len = file.metadata().map_err(|e| e.to_string())?.len();
        if len < TRAILER {
            return Err(INCOMPLETE.into());
        }
        let mut trailer = [0u8; TRAILER as usize];
        file.seek(SeekFrom::Start(len - TRAILER))
            .and_then(|_| file.read_exact(&mut trailer))
            .map_err(|e| e.to_string())?;
        if &trailer[8..] != MAGIC {
            return Err(INCOMPLETE.into());
        }
        let manifest_len = u64::from_le_bytes(trailer[..8].try_into().unwrap());
        let start = len.checked_sub(TRAILER + manifest_len).ok_or(INCOMPLETE)?;
        let mut json = vec![0u8; manifest_len as usize];
        file.seek(SeekFrom::Start(start))
            .and_then(|_| file.read_exact(&mut json))
            .map_err(|e| e.to_string())?;
        let manifest: Manifest =
            serde_json::from_slice(&json).map_err(|e| format!("安装程序清单无效：{e}"))?;
        Ok(Payload { manifest, source })
    }

    /// The entries to put in the install folder.
    pub fn app_files(&self) -> impl Iterator<Item = &Entry> {
        self.manifest
            .files
            .iter()
            .filter(|f| !f.path.starts_with(SETUP_ONLY))
    }

    pub fn entry(&self, prefix: &str) -> Option<&Entry> {
        self.manifest
            .files
            .iter()
            .find(|f| f.path.starts_with(prefix))
    }

    /// Copy one entry to `dest` (through a `.partial` file), reporting bytes as they are written.
    pub fn extract(
        &self,
        entry: &Entry,
        dest: &Path,
        report: &mut dyn FnMut(u64),
    ) -> Result<(), String> {
        let mut source = File::open(&self.source).map_err(|e| e.to_string())?;
        source
            .seek(SeekFrom::Start(entry.offset))
            .map_err(|e| e.to_string())?;
        if let Some(dir) = dest.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("无法创建 {}：{e}", dir.display()))?;
        }
        let partial = partial_path(dest);
        let mut out =
            File::create(&partial).map_err(|e| format!("无法写入 {}：{e}", dest.display()))?;
        let mut left = entry.size;
        let mut buf = vec![0u8; 1 << 20];
        while left > 0 {
            let n = (buf.len() as u64).min(left) as usize;
            source
                .read_exact(&mut buf[..n])
                .map_err(|e| e.to_string())?;
            out.write_all(&buf[..n])
                .map_err(|e| format!("写入失败：{e}"))?;
            left -= n as u64;
            report(n as u64);
        }
        out.sync_all().map_err(|e| e.to_string())?;
        drop(out);
        std::fs::rename(&partial, dest).map_err(|e| format!("无法替换 {}：{e}", dest.display()))
    }

    /// The uninstaller: this exe without payload, carrying an empty uninstall manifest.
    pub fn write_uninstaller(&self, dest: &Path, installed: Vec<String>) -> Result<(), String> {
        let manifest = Manifest {
            role: Role::Uninstall,
            files: Vec::new(),
            installed,
            ..self.manifest.clone()
        };
        let json = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
        let mut source = File::open(&self.source).map_err(|e| e.to_string())?;
        let partial = partial_path(dest);
        let mut out = File::create(&partial).map_err(|e| e.to_string())?;
        io::copy(&mut (&mut source).take(self.manifest.exe_len), &mut out)
            .and_then(|_| out.write_all(&json))
            .and_then(|_| out.write_all(&(json.len() as u64).to_le_bytes()))
            .and_then(|_| out.write_all(MAGIC))
            .and_then(|_| out.sync_all())
            .map_err(|e| e.to_string())?;
        drop(out);
        std::fs::rename(&partial, dest).map_err(|e| format!("无法写入卸载程序：{e}"))
    }
}
