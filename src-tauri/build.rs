fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "engine_invoke",
            "engine_status",
            "desktop_invoke",
        ]),
    ))
    .expect("failed to build restricted Tauri feasibility host");
}
