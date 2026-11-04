//! Launch at login, owned natively. The entry always points at this
//! executable (or the running AppImage); no renderer value names a path.
use std::path::PathBuf;
use twentyonex_engine::EngineError;

fn unavailable() -> EngineError {
    EngineError::new("DISCONNECTED")
}

/// The program the OS should start: the AppImage when this process runs
/// from one. APPIMAGE alone is not trusted: a parent AppImage (a terminal
/// or editor) leaks it into every child, so it must be our own mount.
fn program() -> Result<PathBuf, EngineError> {
    let exe = std::env::current_exe().map_err(|_| unavailable())?;
    #[cfg(target_os = "linux")]
    if let (Some(appimage), Some(appdir)) =
        (std::env::var_os("APPIMAGE"), std::env::var_os("APPDIR"))
    {
        let (appimage, appdir) = (PathBuf::from(appimage), PathBuf::from(appdir));
        if appimage.is_absolute()
            && appimage.is_file()
            && appdir.is_absolute()
            && exe.starts_with(&appdir)
        {
            return Ok(appimage);
        }
    }
    Ok(exe)
}

#[cfg(target_os = "linux")]
fn entry(identifier: &str) -> Result<PathBuf, EngineError> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .ok_or_else(unavailable)?;
    Ok(config
        .join("autostart")
        .join(format!("{identifier}.desktop")))
}

#[cfg(target_os = "macos")]
fn entry(identifier: &str) -> Result<PathBuf, EngineError> {
    let home = std::env::var_os("HOME").ok_or_else(unavailable)?;
    Ok(PathBuf::from(home)
        .join("Library/LaunchAgents")
        .join(format!("{identifier}.plist")))
}

#[cfg(target_os = "macos")]
fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Whether the app starts at login.
pub fn enabled(identifier: &str) -> Result<bool, EngineError> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let path = entry(identifier)?;
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) => Ok(metadata.is_file()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(_) => Err(unavailable()),
        }
    }
    #[cfg(windows)]
    {
        let status = std::process::Command::new("reg")
            .args(["query", RUN_KEY, "/v", identifier])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|_| unavailable())?;
        Ok(status.success())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = identifier;
        Err(EngineError::new("UNKNOWN_OPERATION"))
    }
}

#[cfg(windows)]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

/// Add or remove the login entry; returns the resulting state.
pub fn set(identifier: &str, name: &str, enable: bool) -> Result<bool, EngineError> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let path = entry(identifier)?;
        if !enable {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(unavailable()),
            }
            return enabled(identifier);
        }
        let program = program()?;
        let program = program.to_str().ok_or_else(unavailable)?;
        #[cfg(target_os = "linux")]
        let content = format!(
            "[Desktop Entry]\nType=Application\nName={name}\nExec=\"{}\"\nX-GNOME-Autostart-enabled=true\n",
            program.replace('\\', "\\\\").replace('"', "\\\"")
        );
        #[cfg(target_os = "macos")]
        let content = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>Label</key><string>{}</string><key>ProgramArguments</key><array><string>{}</string></array><key>RunAtLoad</key><true/></dict></plist>\n",
            escape_xml(identifier),
            escape_xml(program)
        );
        #[cfg(target_os = "macos")]
        let _ = name;
        let directory = path.parent().ok_or_else(unavailable)?;
        std::fs::create_dir_all(directory).map_err(|_| unavailable())?;
        let staging = path.with_extension("tmp");
        std::fs::write(&staging, content).map_err(|_| unavailable())?;
        std::fs::rename(&staging, &path).map_err(|_| {
            let _ = std::fs::remove_file(&staging);
            unavailable()
        })?;
        enabled(identifier)
    }
    #[cfg(windows)]
    {
        let _ = name;
        let mut command = std::process::Command::new("reg");
        if enable {
            let program = program()?;
            let program = program.to_str().ok_or_else(unavailable)?;
            command.args([
                "add",
                RUN_KEY,
                "/v",
                identifier,
                "/t",
                "REG_SZ",
                "/d",
                &format!("\"{program}\""),
                "/f",
            ]);
        } else {
            command.args(["delete", RUN_KEY, "/v", identifier, "/f"]);
        }
        let _ = command
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|_| unavailable())?;
        enabled(identifier)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = (identifier, name, enable);
        Err(EngineError::new("UNKNOWN_OPERATION"))
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    #[test]
    fn writes_and_removes_an_xdg_autostart_entry() {
        let root = std::env::temp_dir().join(format!("21x-login-{}", std::process::id()));
        std::env::set_var("XDG_CONFIG_HOME", &root);
        assert!(!super::enabled("com.example.login-test").unwrap());
        assert!(super::set("com.example.login-test", "21x", true).unwrap());
        let text =
            std::fs::read_to_string(root.join("autostart/com.example.login-test.desktop")).unwrap();
        assert!(text.contains("Exec=\"") && text.contains("Name=21x"));
        // A leaked parent AppImage is never written as the program.
        assert!(!text.contains(".AppImage") || std::env::var_os("APPDIR").is_some());
        assert!(!super::set("com.example.login-test", "21x", false).unwrap());
        std::env::remove_var("XDG_CONFIG_HOME");
        std::fs::remove_dir_all(root).unwrap();
    }
}
