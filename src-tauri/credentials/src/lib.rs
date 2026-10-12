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
    if account.is_empty() || account.len() > 128 || !account.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')) {
        return Err("KEYSTORE_PROTOCOL_ERROR");
    }
    // Concrete constructors prohibit keyring's default/mock-store fallback.
    #[cfg(target_os = "linux")]
    let credential = keyring::secret_service::SsCredential::new_with_target(None, SERVICE, account).map_err(sanitized)?;
    #[cfg(target_os = "macos")]
    let credential = keyring::macos::MacCredential::new_with_target(None, SERVICE, account).map_err(sanitized)?;
    #[cfg(target_os = "windows")]
    let credential = keyring::windows::WinCredential::new_with_target(None, SERVICE, account).map_err(sanitized)?;
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    return Ok(Entry::new_with_credential(Box::new(credential)));
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    Err("KEYSTORE_UNSUPPORTED")
}

pub fn load(account: &str) -> Result<Zeroizing<Vec<u8>>, &'static str> {
    let key = Zeroizing::new(entry(account)?.get_secret().map_err(sanitized)?);
    if key.len() != 32 { return Err("KEYSTORE_INVALID_DATA"); }
    Ok(key)
}

/// Caller holds the cross-host profile lock; never replace an existing key.
pub fn create(account: &str, key: &[u8]) -> Result<(), &'static str> {
    if key.len() != 32 { return Err("KEYSTORE_INVALID_DATA"); }
    let credential = entry(account)?;
    match credential.get_secret() {
        Ok(existing) => { let _ = Zeroizing::new(existing); return Err("KEYSTORE_ALREADY_EXISTS"); }
        Err(Error::NoEntry) => {}
        Err(error) => return Err(sanitized(error)),
    }
    credential.set_secret(key).map_err(sanitized)?;
    let verified = Zeroizing::new(credential.get_secret().map_err(sanitized)?);
    if verified.as_slice() != key { return Err("KEYSTORE_INVALID_DATA"); }
    Ok(())
}

pub fn delete_fixture(account: &str) -> Result<(), &'static str> {
    if !account.starts_with("t03-") { return Err("KEYSTORE_PROTOCOL_ERROR"); }
    entry(account)?.delete_credential().map_err(sanitized)
}
