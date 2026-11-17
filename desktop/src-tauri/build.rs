fn main() {
    // App commands only reach the bundled local page: once a capability lets 127.0.0.1 pages call
    // anything, undeclared app commands would be callable from there too.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["retry", "open_log"])),
    )
    .expect("failed to run the tauri build script")
}
