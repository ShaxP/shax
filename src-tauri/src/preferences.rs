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

/// Default width in pixels for the assistant dock (M7.7a).
/// Matches the current overlay panel width so users don't feel a
/// jump when the dock lands.
pub const DEFAULT_ASSISTANT_DOCK_WIDTH: u32 = 420;

fn default_assistant_dock_width() -> u32 {
    DEFAULT_ASSISTANT_DOCK_WIDTH
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preferences {
    #[serde(default)]
    pub theme: ThemePreference,
    /// True when the assistant dock was open at last save. Restored
    /// on launch (M7.7a). Defaults to false — a fresh install opens
    /// with the assistant closed; the user opts in.
    #[serde(default)]
    pub assistant_docked: bool,
    /// Width in pixels of the assistant dock's right-side column.
    /// Persists across launches so a user's chosen width sticks. A
    /// clamped range is enforced on write from the frontend; this
    /// side just stores whatever it's given.
    #[serde(default = "default_assistant_dock_width")]
    pub assistant_dock_width: u32,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: ThemePreference::default(),
            assistant_docked: false,
            assistant_dock_width: DEFAULT_ASSISTANT_DOCK_WIDTH,
        }
    }
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
            ..Preferences::default()
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

    #[test]
    fn defaults_include_assistant_dock_fields() {
        let p = Preferences::default();
        assert!(!p.assistant_docked);
        assert_eq!(p.assistant_dock_width, DEFAULT_ASSISTANT_DOCK_WIDTH);
    }

    #[test]
    fn assistant_dock_fields_round_trip() {
        let p = Preferences {
            theme: ThemePreference::Dark,
            assistant_docked: true,
            assistant_dock_width: 512,
        };
        let json = serde_json::to_string(&p).unwrap();
        let back: Preferences = serde_json::from_str(&json).unwrap();
        assert!(back.assistant_docked);
        assert_eq!(back.assistant_dock_width, 512);
    }

    #[test]
    fn old_preferences_json_without_dock_fields_gets_defaults() {
        // Backward compatibility — a preferences.json written before
        // M7.7a shipped had only the `theme` field. Deserialise picks
        // up defaults for the new fields via `#[serde(default)]`.
        let old_json = r#"{"theme":"dark"}"#;
        let p: Preferences = serde_json::from_str(old_json).unwrap();
        assert_eq!(p.theme, ThemePreference::Dark);
        assert!(!p.assistant_docked);
        assert_eq!(p.assistant_dock_width, DEFAULT_ASSISTANT_DOCK_WIDTH);
    }
}
