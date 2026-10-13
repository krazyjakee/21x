fn main() {
    if std::env::var_os("CARGO_FEATURE_PRODUCTION_SERVICE").is_some() {
        use sha2::{Digest, Sha256};
        let manifest = std::path::Path::new("resources/service/PRODUCTION_RESOURCE_MANIFEST.json");
        println!("cargo:rerun-if-changed={}", manifest.display());
        let metadata = std::fs::symlink_metadata(manifest).expect(
            "stage the production resource manifest before compiling the production feature",
        );
        assert!(
            metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() <= 32 * 1024 * 1024,
            "invalid production resource manifest"
        );
        let bytes = std::fs::read(manifest).expect("production manifest is unreadable");
        let identity: serde_json::Value =
            serde_json::from_slice(&bytes).expect("production manifest is invalid JSON");
        let build = identity["buildIdentity"]
            .as_str()
            .expect("production build identity is missing");
        assert!(
            !build.is_empty()
                && build.len() <= 128
                && build
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')),
            "invalid production build identity"
        );
        println!("cargo:rustc-env=TWENTYONEX_PRODUCTION_BUILD_ID={build}");
        println!(
            "cargo:rustc-env=TWENTYONEX_PRODUCTION_MANIFEST_SHA256={:x}",
            Sha256::digest(&bytes)
        );
    }
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "engine_invoke",
            "engine_status",
            "desktop_invoke",
        ]),
    ))
    .expect("failed to build restricted Tauri feasibility host");
}
