fn main() {
    // Icon (same .ico as the app, from `pnpm icons`) and an asInvoker manifest: without one, Windows
    // treats an exe named "*setup*" as an installer and asks for administrator rights.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rerun-if-changed=setup.rc");
        println!("cargo:rerun-if-changed=setup.exe.manifest");
        println!("cargo:rerun-if-changed=../src-tauri/icons/windows/icon.ico");
        embed_resource::compile("setup.rc", embed_resource::NONE)
            .manifest_required()
            .unwrap();
    }
}
