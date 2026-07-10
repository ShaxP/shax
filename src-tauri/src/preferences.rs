//! App-level user preferences — small JSON file next to
//! `assistant.json` under the platform config dir.
//!
//! Deliberately separate from `AssistantConfig`: theme and
//! future UI knobs aren't assistant-related and shouldn't be
//! lost if the assistant config gets corrupted. Also small
//! enough that a bad manual edit doesn't brick the app —
//! malformed JSON falls back to defaults with a warn log.
//!
//! Introduced in M7 slice 1 for the light-theme toggle. The
//! shape is intentionally forward-compatible: every field
//! is `#[serde(default)]` so future additions can be pushed
//! without a migration.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use thiserror::Error;

use crate::agent::config::platform_config_dir;

/// The user's theme preference. `System` follows
/// `prefers-color-scheme`; concrete values force it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ThemePreference {
    Dark,
    Light,
    #[default]
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Preferences {
    #[serde(default)]
    pub theme: ThemePreference,
}

#[derive(Debug, Error)]
pub enum PreferencesError {
    #[error("no config directory available")]
    NoConfigDir,
    #[error("io: {0}")]
    Io(String),
    #[error("json: {0}")]
    Json(String),
}

impl From<std::io::Error> for PreferencesError {
    fn from(e: std::io::Error) -> Self {
        PreferencesError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for PreferencesError {
    fn from(e: serde_json::Error) -> Self {
        PreferencesError::Json(e.to_string())
    }
}

fn preferences_path() -> Result<PathBuf, PreferencesError> {
    let base = platform_config_dir().ok_or(PreferencesError::NoConfigDir)?;
    Ok(base.join("shax").join("preferences.json"))
}

/// Load preferences. Missing / malformed → defaults, never
/// fatal. Same tolerance rules as `agent::config::load` and
/// `agent::history::load`.
pub fn load() -> Result<Preferences, PreferencesError> {
    let path = preferences_path()?;
    if !path.exists() {
        return Ok(Preferences::default());
    }
    let text = std::fs::read_to_string(&path)?;
    match serde_json::from_str::<Preferences>(&text) {
        Ok(p) => Ok(p),
        Err(e) => {
            tracing::warn!("preferences parse failed, falling back to defaults: {e}");
            Ok(Preferences::default())
        }
    }
}

/// Overwrite the preferences file atomically (write to
/// sibling tempfile then rename).
pub fn save(preferences: &Preferences) -> Result<(), PreferencesError> {
    let path = preferences_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(preferences)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_system_theme() {
        let p = Preferences::default();
        assert_eq!(p.theme, ThemePreference::System);
    }

    #[test]
    fn serialises_theme_as_kebab_case() {
        let p = Preferences {
            theme: ThemePreference::Light,
        };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains(r#""theme":"light""#));
    }

    #[test]
    fn deserialises_missing_theme_as_system() {
        let json = "{}";
        let p: Preferences = serde_json::from_str(json).unwrap();
        assert_eq!(p.theme, ThemePreference::System);
    }

    #[test]
    fn deserialises_all_three_theme_values() {
        for (raw, expected) in [
            (r#"{"theme":"dark"}"#, ThemePreference::Dark),
            (r#"{"theme":"light"}"#, ThemePreference::Light),
            (r#"{"theme":"system"}"#, ThemePreference::System),
        ] {
            let p: Preferences = serde_json::from_str(raw).unwrap();
            assert_eq!(p.theme, expected);
        }
    }
}
