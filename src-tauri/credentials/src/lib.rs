use keyring::{Entry, Error};
use zeroize::Zeroizing;

const SERVICE: &str = "com.krazyjakee.21x.credentials.v1";

pub fn backend() -> &'static str {
    #[cfg(target_os = "linux")]
    return "linux-secret-service";
    #[cfg(target_os = "macos")]
    return "macos-keychain";
    #[cfg(target_os = "windows")]
    return "windows-credential-store";
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    return "unsupported";
}

fn sanitized(error: Error) -> &'static str {
    match error {
        Error::NoEntry => "KEYSTORE_NO_ENTRY",
        Error::NoStorageAccess(_) => "KEYSTORE_NO_ACCESS",
        Error::BadEncoding(_) | Error::Ambiguous(_) => "KEYSTORE_INVALID_DATA",
        _ => "KEYSTORE_NO_ACCESS",
    }
}

fn entry(account: &str) -> Result<Entry, &'static str> {
    if account.is_empty()
        || account.len() > 128
        || !account
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("KEYSTORE_PROTOCOL_ERROR");
    }
    // Concrete constructors prohibit keyring's default/mock-store fallback.
    #[cfg(target_os = "linux")]
    let credential = keyring::secret_service::SsCredential::new_with_target(None, SERVICE, account)
        .map_err(sanitized)?;
    #[cfg(target_os = "macos")]
    let credential = keyring::macos::MacCredential::new_with_target(None, SERVICE, account)
        .map_err(sanitized)?;
    #[cfg(target_os = "windows")]
    let credential = keyring::windows::WinCredential::new_with_target(None, SERVICE, account)
        .map_err(sanitized)?;
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    return Ok(Entry::new_with_credential(Box::new(credential)));
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    Err("KEYSTORE_UNSUPPORTED")
}

pub fn load(account: &str) -> Result<Zeroizing<Vec<u8>>, &'static str> {
    let key = Zeroizing::new(entry(account)?.get_secret().map_err(sanitized)?);
    if key.len() != 32 {
        return Err("KEYSTORE_INVALID_DATA");
    }
    Ok(key)
}

/// Caller holds the cross-host profile lock; never replace an existing key.
pub fn create(account: &str, key: &[u8]) -> Result<(), &'static str> {
    if key.len() != 32 {
        return Err("KEYSTORE_INVALID_DATA");
    }
    let credential = entry(account)?;
    match credential.get_secret() {
        Ok(existing) => {
            let _ = Zeroizing::new(existing);
            return Err("KEYSTORE_ALREADY_EXISTS");
        }
        Err(Error::NoEntry) => {}
        Err(error) => return Err(sanitized(error)),
    }
    credential.set_secret(key).map_err(sanitized)?;
    let verified = Zeroizing::new(credential.get_secret().map_err(sanitized)?);
    if verified.as_slice() != key {
        return Err("KEYSTORE_INVALID_DATA");
    }
    Ok(())
}

pub fn delete_fixture(account: &str) -> Result<(), &'static str> {
    if !account.starts_with("t03-") {
        return Err("KEYSTORE_PROTOCOL_ERROR");
    }
    entry(account)?.delete_credential().map_err(sanitized)
}

/// Read-only: the password Electron's `safeStorage` (Chromium os_crypt) keeps
/// for `app`, so a trusted importer can decrypt that app's legacy values.
/// Never creates, replaces or deletes the legacy entry.
pub fn load_electron_safe_storage(app: &str) -> Result<Zeroizing<Vec<u8>>, &'static str> {
    if app.is_empty()
        || app.len() > 64
        || !app
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("KEYSTORE_PROTOCOL_ERROR");
    }
    #[cfg(target_os = "linux")]
    {
        use dbus_secret_service::{EncryptionType, SecretService};
        use std::collections::HashMap;
        let service =
            SecretService::connect(EncryptionType::Dh).map_err(|_| "KEYSTORE_NO_ACCESS")?;
        // Chromium writes the v2 schema; older builds used the unversioned one.
        for schema in [
            "chrome_libsecret_os_crypt_password_v2",
            "chrome_libsecret_os_crypt_password",
        ] {
            let found = service
                .search_items(HashMap::from([
                    ("xdg:schema", schema),
                    ("application", app),
                ]))
                .map_err(|_| "KEYSTORE_NO_ACCESS")?;
            let item = match (found.unlocked.first(), found.locked.first()) {
                (Some(item), _) => item,
                (None, Some(item)) => {
                    item.unlock().map_err(|_| "KEYSTORE_NO_ACCESS")?;
                    item
                }
                (None, None) => continue,
            };
            let secret = Zeroizing::new(item.get_secret().map_err(|_| "KEYSTORE_NO_ACCESS")?);
            if secret.is_empty() || secret.len() > 1024 {
                return Err("KEYSTORE_INVALID_DATA");
            }
            return Ok(secret);
        }
        Err("KEYSTORE_NO_ENTRY")
    }
    #[cfg(target_os = "macos")]
    {
        // Electron names its Keychain item "<app> Safe Storage" / "<app> Key".
        let credential = keyring::macos::MacCredential::new_with_target(
            None,
            &format!("{app} Safe Storage"),
            &format!("{app} Key"),
        )
        .map_err(sanitized)?;
        let secret = Zeroizing::new(
            Entry::new_with_credential(Box::new(credential))
                .get_secret()
                .map_err(sanitized)?,
        );
        if secret.is_empty() || secret.len() > 1024 {
            return Err("KEYSTORE_INVALID_DATA");
        }
        Ok(secret)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    Err("KEYSTORE_UNSUPPORTED")
}
