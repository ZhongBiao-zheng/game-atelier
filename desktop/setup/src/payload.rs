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
    thread,
    time::Duration,
};

const MAGIC: &[u8; 8] = b"ATELPAY1";
const TRAILER: u64 = 16;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Install,
    Uninstall,
}

/// How an entry's bytes are stored: app files are raw deflate, the installer's own files as they are.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Codec {
    #[default]
    Store,
    Deflate,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Entry {
    /// Path inside the install directory, `/`-separated.
    pub path: String,
    pub offset: u64,
    /// Stored size (compressed when `codec` is deflate).
    pub size: u64,
    #[serde(default)]
    pub codec: Codec,
}

/// Counts stored bytes as they are read, so progress follows the payload whatever the codec.
struct Counted<'a, R> {
    inner: R,
    report: &'a mut dyn FnMut(u64),
}

impl<R: Read> Read for Counted<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        (self.report)(n as u64);
        Ok(n)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Manifest {
    pub role: Role,
    pub product: String,
    pub version: String,
    /// The app's main program, relative to the install folder (shortcuts, launch, Apps entry).
    pub main: String,
    /// The app's AppUserModelID (electron-builder `appId`); shortcuts carry it so the taskbar
    /// groups the pinned shortcut with the running window.
    #[serde(default)]
    pub app_id: String,
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

/// Next to `dest`, hidden, with a suffix nothing else uses: a half-written file is never taken for the real one.
pub fn partial_path(dest: &Path) -> PathBuf {
    let name = dest.file_name().unwrap_or_default().to_string_lossy();
    dest.with_file_name(format!(".{name}.partial"))
}

/// Attempts at putting a file in place while Windows still reports it in use.
const REPLACE_ATTEMPTS: u64 = 12;

/// Access denied (5), sharing violation (32), lock violation (33): someone still holds the file.
fn in_use(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied || matches!(error.raw_os_error(), Some(32 | 33))
}

/// Move `partial` over `dest`. An exe that has just exited, or one a scanner is reading, stays
/// locked for a moment, so a refusal is retried with backoff (about 15 s in all) before failing.
pub fn replace(partial: &Path, dest: &Path) -> Result<(), String> {
    let mut attempt = 1;
    loop {
        match std::fs::rename(partial, dest) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < REPLACE_ATTEMPTS && in_use(&e) => {
                crate::install::log(&format!("{} in use ({e}); retry {attempt}", dest.display()));
                thread::sleep(Duration::from_millis((250 * attempt).min(2000)));
                attempt += 1;
            }
            Err(e) => return Err(format!("无法替换 {}：{e}", dest.display())),
        }
    }
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
        let partial = self.unpack(entry, dest, report)?;
        replace(&partial, dest)
    }

    /// Write one entry next to `dest` as its `.partial` file, leaving `dest` untouched.
    pub fn unpack(
        &self,
        entry: &Entry,
        dest: &Path,
        report: &mut dyn FnMut(u64),
    ) -> Result<PathBuf, String> {
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
        let stored = Counted {
            inner: io::BufReader::with_capacity(1 << 20, source.take(entry.size)),
            report,
        };
        let copied = match entry.codec {
            Codec::Store => io::copy(&mut { stored }, &mut out),
            Codec::Deflate => io::copy(&mut flate2::read::DeflateDecoder::new(stored), &mut out),
        };
        copied.map_err(|e| format!("写入 {} 失败：{e}", dest.display()))?;
        out.sync_all().map_err(|e| e.to_string())?;
        Ok(partial)
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
        replace(&partial, dest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt;

    #[test]
    fn replace_waits_for_a_file_held_open_elsewhere() {
        let dir = std::env::temp_dir().join(format!("atelier-replace-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (dest, partial) = (dir.join("Atelier.exe"), dir.join(".Atelier.exe.partial"));
        std::fs::write(&dest, b"old").unwrap();
        std::fs::write(&partial, b"new").unwrap();
        // Held without any sharing, as an exe that is still exiting would be.
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&dest)
            .unwrap();
        let holder = thread::spawn(move || {
            thread::sleep(Duration::from_millis(800));
            drop(held);
        });
        replace(&partial, &dest).unwrap();
        holder.join().unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
        assert!(!partial.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
