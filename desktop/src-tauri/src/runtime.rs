//! The shell's side of docs/contracts/desktop-shell.md: it only touches the runtime bundle
//! through its fixed launcher, and the server through `.runtime` records and loopback HTTP.

use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// Shared with the Python side (`APP_NAME`), independent of the product name.
const APP_DIR: &str = "game-atelier";
const BUNDLE_DIR: &str = "GameAtelier";

static LOG_FILE: OnceLock<PathBuf> = OnceLock::new();

pub fn log(line: &str) {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Never panic on a closed stderr (Finder launches, pipes).
    let _ = writeln!(std::io::stderr(), "[shell] {line}");
    if let Some(path) = LOG_FILE.get() {
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{stamp} {line}");
        }
    }
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `<local data>/game-atelier/runtime`: writable, outside the read-only app bundle.
pub fn runtime_parent(local_data: &Path) -> PathBuf {
    let parent = local_data.join(APP_DIR).join("runtime");
    let _ = fs::create_dir_all(&parent);
    let _ = LOG_FILE.set(parent.join("shell.log"));
    parent
}

fn read_trim(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn valid_version(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

/// A bundle is usable when `last-good` names a complete version directory (ADR-0030).
fn validate_bundle(root: &Path) -> Result<(), String> {
    let version = read_trim(&root.join("last-good")).ok_or("运行包缺少 last-good")?;
    if !valid_version(&version) {
        return Err(format!("运行包版本无效：{version}"));
    }
    let payload = root.join("versions").join(&version);
    let python = if cfg!(windows) {
        payload.join("python/python.exe")
    } else {
        payload.join("python/bin/python3")
    };
    if read_trim(&payload.join("VERSION")).as_deref() != Some(version.as_str()) || !python.is_file()
    {
        return Err(format!("运行包版本目录不完整：{version}"));
    }
    Ok(())
}

pub fn seed_version(seed: &Path) -> Option<String> {
    let name = seed.file_name()?.to_str()?;
    let version = name.strip_prefix("GameAtelier-")?.split('-').next()?;
    valid_version(version).then(|| version.to_string())
}

/// Counts compressed bytes read so the window can show real progress while unpacking.
struct Progress<'a, R> {
    inner: R,
    done: u64,
    total: u64,
    report: &'a dyn Fn(u64, u64),
}

impl<R: Read> Read for Progress<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.done += n as u64;
        (self.report)(self.done, self.total);
        Ok(n)
    }
}

fn extract(seed: &Path, staging: &Path, report: &dyn Fn(u64, u64)) -> Result<(), String> {
    let file = fs::File::open(seed).map_err(|e| format!("打不开运行包：{e}"))?;
    let total = file.metadata().map(|m| m.len()).unwrap_or(0);
    let reader = Progress {
        inner: std::io::BufReader::new(file),
        done: 0,
        total,
        report,
    };
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(reader));
    archive.set_preserve_permissions(true);
    archive.set_preserve_mtime(true);
    // `unpack` refuses entries that would escape `staging`.
    archive
        .unpack(staging)
        .map_err(|e| format!("解压运行包失败：{e}"))
}

/// Existing runtime wins; the seed only creates it the first time (newer seeds: batch 3).
pub fn prepare(parent: &Path, seed: &Path, report: &dyn Fn(u64, u64)) -> Result<PathBuf, String> {
    let root = parent.join(BUNDLE_DIR);
    if validate_bundle(&root).is_ok() {
        return Ok(root);
    }
    if !seed.is_file() {
        return Err(format!("安装包里缺少运行环境：{}", seed.display()));
    }
    let staging = parent.join(format!(".staging-{}", std::process::id()));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let result = extract(seed, &staging, report).and_then(|()| {
        let extracted = staging.join(BUNDLE_DIR);
        validate_bundle(&extracted)?;
        if root.exists() {
            // Only an incomplete earlier attempt can be here: validate_bundle failed above.
            fs::remove_dir_all(&root).map_err(|e| format!("清理不完整的运行包失败：{e}"))?;
        }
        fs::rename(&extracted, &root).map_err(|e| format!("安装运行包失败：{e}"))
    });
    let _ = fs::remove_dir_all(&staging);
    result.map(|()| root)
}

/// Ordering key shared with `bootstrap.version_key`: 5.x is the retired line and sorts first.
fn version_key(version: &str) -> Option<(u8, Vec<u64>)> {
    if !valid_version(version) {
        return None;
    }
    let parts: Vec<u64> = version.split('.').filter_map(|p| p.parse().ok()).collect();
    Some((u8::from(parts[0] != 5), parts))
}

/// Whether `runtime` is at least `shell`; unknown versions count as older.
pub fn at_least(runtime: &str, shell: &str) -> bool {
    match (version_key(runtime), version_key(shell)) {
        (Some(a), Some(b)) => a >= b,
        _ => false,
    }
}

/// `light` / `dark` as the page last reported it (see `save_theme`).
pub fn saved_theme(parent: &Path) -> Option<String> {
    read_trim(&parent.join("window-theme")).filter(|t| t == "light" || t == "dark")
}

pub fn save_theme(parent: &Path, theme: &str) {
    let _ = fs::write(parent.join("window-theme"), theme);
}

/// The version the launcher would start (`current`, falling back to `last-good`), if installed.
pub fn installed_version(root: &Path) -> Option<String> {
    ["current", "last-good"]
        .iter()
        .filter_map(|name| read_trim(&root.join(name)))
        .find(|v| valid_version(v))
}

/// Where the runtime lives (or will be unpacked to); `ATELIER_RUNTIME_ROOT` is for development.
pub fn runtime_root(parent: &Path) -> PathBuf {
    std::env::var_os("ATELIER_RUNTIME_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| parent.join(BUNDLE_DIR))
}

pub struct Runtime {
    pub root: PathBuf,
}

impl Runtime {
    fn launcher(&self, args: &[&str]) -> Command {
        #[cfg(not(windows))]
        let mut cmd = {
            let mut cmd = Command::new("/bin/sh");
            cmd.arg(self.root.join("启动.command"));
            cmd
        };
        #[cfg(windows)]
        let mut cmd = {
            use std::os::windows::process::CommandExt;
            let mut cmd = Command::new("powershell.exe");
            cmd.args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(self.root.join("launch.ps1"));
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            cmd
        };
        cmd.args(args)
            .env_remove("VIRTUAL_ENV")
            .env_remove("UV_PROJECT_ENVIRONMENT");
        cmd
    }

    /// Err carries only what the launcher wrote to stderr for users (empty when it gave no
    /// reason); internal failures go to the log, not to the window.
    fn run(&self, args: &[&str], data_root: Option<&Path>) -> Result<String, String> {
        let mut cmd = self.launcher(args);
        if let Some(root) = data_root {
            cmd.env("GAME_ATELIER_DATA_ROOT", root);
        }
        let out = cmd.output().map_err(|e| {
            log(&format!("cannot run the launcher: {e}"));
            String::new()
        })?;
        log(&format!("launcher {args:?} -> {:?}", out.status.code()));
        if out.status.success() {
            return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
        }
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: Vec<&str> = err
            .lines()
            .filter(|l| !l.trim().is_empty())
            .rev()
            .take(6)
            .collect();
        let message = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
        log(&format!("launcher stderr: {message}"));
        Err(message)
    }

    /// Single source of truth for the data root (`bootstrap.py --print-data-root`).
    pub fn data_root(&self) -> Result<PathBuf, String> {
        let out = self.run(&["--print-data-root"], None)?;
        let line = out.lines().next().unwrap_or("").trim();
        if line.is_empty() {
            log("the launcher printed no data root");
            return Err(String::new());
        }
        Ok(PathBuf::from(line))
    }

    /// Starts the server and returns the data root it uses (the launcher's last stdout line).
    pub fn start(&self) -> Result<PathBuf, String> {
        let out = self.run(&["--desktop-start"], None)?;
        out.lines()
            .rev()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| {
                log("the launcher printed no data root");
                String::new()
            })
    }

    /// Pinned to the data root the server was started with: the page may switch the configured
    /// root while this server keeps its records in the old one.
    pub fn stop(&self, data_root: &Path) -> Result<(), String> {
        self.run(
            &["--run", "-m", "viewer_server.server", "stop"],
            Some(data_root),
        )
        .map(|_| ())
    }

    pub fn update_in_progress(&self, data_root: &Path) -> bool {
        self.root.join("updates/pending.json").exists()
            || data_root.join(".runtime/maintenance").exists()
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Server {
    pub port: u16,
    pub instance: String,
}

fn http_get(port: u16, path: &str, bearer: Option<&str>) -> Option<(u16, String)> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(800)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    let auth = bearer
        .map(|t| format!("Authorization: Bearer {t}\r\n"))
        .unwrap_or_default();
    write!(
        stream,
        "GET {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\n{auth}\r\n"
    )
    .ok()?;
    let mut buf = Vec::new();
    stream.take(64 * 1024).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let (head, body) = text.split_once("\r\n\r\n")?;
    let status = head.split_whitespace().nth(1)?.parse().ok()?;
    Some((status, body.to_string()))
}

/// The recorded server, only if it answers with the recorded instance id.
pub fn verified_server(data_root: &Path) -> Option<Server> {
    let runtime = data_root.join(".runtime");
    let port: u16 = read_trim(&runtime.join("server.port"))?.parse().ok()?;
    let instance = read_trim(&runtime.join("server.instance"))?;
    let (status, body) = http_get(port, "/api/connection/status", None)?;
    let body: serde_json::Value = serde_json::from_str(&body).ok()?;
    (status == 200 && body["service"] == "game-atelier" && body["instance_id"] == instance.as_str())
        .then_some(Server { port, instance })
}

/// Total in-flight work, or None when the server cannot tell us (treated as "maybe busy").
pub fn active_work(data_root: &Path, server: &Server) -> Option<u64> {
    let raw = fs::read_to_string(data_root.join(".runtime/shell-control.json")).ok()?;
    let control: serde_json::Value = serde_json::from_str(&raw).ok()?;
    if control["instance_id"] != server.instance.as_str() {
        return None;
    }
    let (status, body) = http_get(
        server.port,
        "/api/shell/active-work",
        control["token"].as_str(),
    )?;
    let counts: serde_json::Value = serde_json::from_str(&body).ok()?;
    (status == 200).then(|| {
        counts
            .as_object()
            .map(|m| m.values().filter_map(|v| v.as_u64()).sum())
            .unwrap_or(0)
    })
}

/// Survives a shell crash, so a reopened shell still stops the server it started.
pub fn mark_owned(data_root: &Path, server: &Server) {
    let _ = fs::write(data_root.join(".runtime/shell-owned"), &server.instance);
}

pub fn is_owned(data_root: &Path, server: &Server) -> bool {
    read_trim(&data_root.join(".runtime/shell-owned")).as_deref() == Some(server.instance.as_str())
}

pub fn clear_owned(data_root: &Path) {
    let _ = fs::remove_file(data_root.join(".runtime/shell-owned"));
}

/// `name.ext`, `name (1).ext`, … so a download never overwrites an existing file.
pub fn unique_download_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("download");
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_rules_match_the_bundle_layout() {
        assert!(valid_version("5.138.0"));
        assert!(!valid_version("5.138"));
        assert!(!valid_version("5.138.0-rc1"));
        assert!(!valid_version("../1.2.3"));
    }

    #[test]
    fn versions_order_like_bootstrap() {
        assert!(at_least("5.139.0", "5.138.0"));
        assert!(at_least("5.138.0", "5.138.0"));
        assert!(!at_least("5.137.9", "5.138.0"));
        // 0.5.x replaced the retired 5.x line (ADR-0032).
        assert!(at_least("0.5.134", "5.138.0"));
        assert!(!at_least("5.200.0", "0.5.134"));
        assert!(!at_least("garbage", "5.138.0"));
    }

    #[test]
    fn seed_name_carries_the_version() {
        let seed = Path::new("/x/GameAtelier-5.138.0-macos-arm64.tar.gz");
        assert_eq!(seed_version(seed).as_deref(), Some("5.138.0"));
        assert_eq!(seed_version(Path::new("/x/other.tar.gz")), None);
    }

    #[test]
    fn downloads_never_overwrite() {
        let dir = std::env::temp_dir().join(format!("atelier-dl-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(unique_download_path(&dir, "a.png"), dir.join("a.png"));
        fs::write(dir.join("a.png"), b"x").unwrap();
        fs::write(dir.join("a (1).png"), b"x").unwrap();
        assert_eq!(unique_download_path(&dir, "a.png"), dir.join("a (2).png"));
        fs::remove_dir_all(&dir).unwrap();
    }
}
