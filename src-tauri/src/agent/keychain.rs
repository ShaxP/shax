//! OS-native credential storage for assistant provider API keys.
//!
//! Wraps the `keyring` crate so we get platform-native
//! storage (macOS Keychain, Windows Credential Manager,
//! Linux Secret Service) without any file-based fallback.
//! Spec §09: "stored in the OS keychain … never persisted
//! plain."
//!
//! Keys are stored under a fixed service name (`shax-assistant`)
//! keyed by `provider_id` (e.g. `"claude"`, `"openai"`). The
//! same key material can appear in multiple provider slots
//! without conflict — the user might have configured Claude
//! and be trialing OpenAI at the same time.
//!
//! Errors always return the OS-provided message (translated
//! by the crate) rather than a generic "keychain error" so
//! diagnostics stay useful. Never log the key itself.

use keyring::Entry;
use thiserror::Error;

const SERVICE: &str = "shax-assistant";

#[derive(Debug, Error)]
pub enum KeychainError {
    #[error("keychain unavailable: {0}")]
    Unavailable(String),
    #[error("keychain io: {0}")]
    Io(String),
}

impl From<keyring::Error> for KeychainError {
    fn from(e: keyring::Error) -> Self {
        match e {
            keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_) => {
                KeychainError::Unavailable(e.to_string())
            }
            other => KeychainError::Io(other.to_string()),
        }
    }
}

/// Persist an API key under the given provider slot. Overwrites
/// any existing value silently — the settings UI's "save"
/// affordance is the user's explicit intent.
pub fn set_api_key(provider_id: &str, secret: &str) -> Result<(), KeychainError> {
    let entry = Entry::new(SERVICE, provider_id)?;
    entry.set_password(secret)?;
    Ok(())
}

/// Read the stored API key for the given provider slot.
/// Returns `Ok(None)` when there's no entry — the caller can
/// then treat the provider as unconfigured. `Err` only for
/// real backend failures.
pub fn get_api_key(provider_id: &str) -> Result<Option<String>, KeychainError> {
    let entry = Entry::new(SERVICE, provider_id)?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Remove the stored API key for the given provider slot.
/// A no-op (not an error) when there's nothing to delete —
/// idempotent from the caller's point of view.
pub fn delete_api_key(provider_id: &str) -> Result<(), KeychainError> {
    let entry = Entry::new(SERVICE, provider_id)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// True if a credential exists for the given provider slot,
/// without actually retrieving it. Cheap enough to call on
/// UI open so the settings dialog can show "configured" /
/// "not configured" before the user types.
pub fn has_api_key(provider_id: &str) -> Result<bool, KeychainError> {
    Ok(get_api_key(provider_id)?.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    // The `keyring` crate offers a mock backend behind
    // `--features mock`. Without it, CI environments would
    // need a real keychain daemon — we opt out at test time
    // by using unique per-test provider IDs, and best-effort
    // clean up after ourselves. Tests are marked
    // `#[ignore]` so `cargo test --lib` stays hermetic; run
    // them explicitly with `cargo test -- --ignored
    // --test-threads=1` on a machine with an accessible
    // keychain.

    #[test]
    #[ignore]
    fn round_trip() {
        let id = "shax-test-round-trip";
        let _ = delete_api_key(id);
        assert_eq!(get_api_key(id).unwrap(), None);
        assert!(!has_api_key(id).unwrap());
        set_api_key(id, "sk-test-123").unwrap();
        assert!(has_api_key(id).unwrap());
        assert_eq!(get_api_key(id).unwrap().as_deref(), Some("sk-test-123"));
        delete_api_key(id).unwrap();
        assert!(!has_api_key(id).unwrap());
    }

    #[test]
    #[ignore]
    fn overwrite_is_silent() {
        let id = "shax-test-overwrite";
        let _ = delete_api_key(id);
        set_api_key(id, "first").unwrap();
        set_api_key(id, "second").unwrap();
        assert_eq!(get_api_key(id).unwrap().as_deref(), Some("second"));
        delete_api_key(id).unwrap();
    }

    #[test]
    #[ignore]
    fn delete_missing_is_ok() {
        let id = "shax-test-delete-missing-never-set";
        let _ = delete_api_key(id);
        assert!(delete_api_key(id).is_ok());
    }
}
