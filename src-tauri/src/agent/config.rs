//! Assistant configuration persistence.
//!
//! Small JSON file under the platform's config directory
//! that stores the user's assistant preferences: which
//! provider is active, which auth lane they picked, an
//! optional model override.
//!
//! Deliberately not stuffed into the general app-state file
//! — the config is small, gets set-once-and-forget, and
//! keeping it separate means a corrupt tab layout doesn't
//! also lose the user's assistant lane choice.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use thiserror::Error;

/// Which auth lane the user picked for Claude. Extends
/// naturally when more providers land (`"ollama"`, etc.) —
/// the enum has an escape hatch via `Other`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ClaudeLane {
    ApiKey,
    Subscription,
    #[default]
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AssistantConfig {
    /// Which provider is the active one. `"claude"`,
    /// `"ollama"` for M6 slices 2 + 3; future values include
    /// `"openai"`, `"copilot"`, `"mlx"`.
    #[serde(default = "default_provider")]
    pub provider: String,
    /// Which lane Claude uses when it's the active provider.
    #[serde(default)]
    pub claude_lane: ClaudeLane,
    /// Optional Claude model override — when None, the
    /// provider picks its own default. Renamed from `model`
    /// in slice 3; the `alias` keeps old configs readable.
    #[serde(default, alias = "model")]
    pub claude_model: Option<String>,
    /// Selected Ollama model — required to make a request
    /// (no default). None when Ollama isn't the active
    /// provider or the user hasn't picked yet.
    #[serde(default)]
    pub ollama_model: Option<String>,
}

fn default_provider() -> String {
    "claude".to_string()
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("no config directory available")]
    NoConfigDir,
    #[error("io: {0}")]
    Io(String),
    #[error("json: {0}")]
    Json(String),
}

impl From<std::io::Error> for ConfigError {
    fn from(e: std::io::Error) -> Self {
        ConfigError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for ConfigError {
    fn from(e: serde_json::Error) -> Self {
        ConfigError::Json(e.to_string())
    }
}

pub fn config_path() -> Result<PathBuf, ConfigError> {
    let base = platform_config_dir().ok_or(ConfigError::NoConfigDir)?;
    Ok(base.join("shax").join("assistant.json"))
}

/// Cross-platform config directory. Mirrors what most Tauri
/// apps use without pulling in the `dirs` crate — small
/// enough to inline. Shared by `config.rs` and `history.rs`.
pub(super) fn platform_config_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        return std::env::var_os("HOME").map(|home| {
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
        });
    }
    #[cfg(target_os = "windows")]
    {
        return std::env::var_os("APPDATA").map(PathBuf::from);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
            return Some(PathBuf::from(xdg));
        }
        return std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config"));
    }
    #[allow(unreachable_code)]
    None
}

/// Load the config. Missing file → default. Malformed file
/// → default (so a bad edit doesn't brick the settings UI —
/// the user can just re-save). Errors bubble up only for
/// unrecoverable IO / permission issues.
pub fn load() -> Result<AssistantConfig, ConfigError> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(AssistantConfig::default());
    }
    let text = std::fs::read_to_string(&path)?;
    match serde_json::from_str(&text) {
        Ok(cfg) => Ok(cfg),
        Err(e) => {
            tracing::warn!("assistant config parse failed, falling back to default: {e}");
            Ok(AssistantConfig::default())
        }
    }
}

/// Overwrite the config file atomically-enough for a tiny
/// file (write to sibling then rename).
pub fn save(config: &AssistantConfig) -> Result<(), ConfigError> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(config)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_no_provider_configured() {
        let cfg = AssistantConfig::default();
        assert_eq!(cfg.provider, "");
        assert_eq!(cfg.claude_lane, ClaudeLane::None);
        assert_eq!(cfg.claude_model, None);
        assert_eq!(cfg.ollama_model, None);
    }

    #[test]
    fn config_serialises_lane_as_kebab_case() {
        let cfg = AssistantConfig {
            provider: "claude".into(),
            claude_lane: ClaudeLane::ApiKey,
            claude_model: Some("claude-sonnet-4-6".into()),
            ollama_model: None,
        };
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains(r#""claude_lane":"api-key""#));
        assert!(json.contains(r#""claude_model":"claude-sonnet-4-6""#));
    }

    #[test]
    fn config_deserialises_kebab_case_and_missing_fields() {
        let json = r#"{"provider":"claude","claude_lane":"subscription"}"#;
        let cfg: AssistantConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.provider, "claude");
        assert_eq!(cfg.claude_lane, ClaudeLane::Subscription);
        assert_eq!(cfg.claude_model, None);
        assert_eq!(cfg.ollama_model, None);
    }

    #[test]
    fn config_migrates_old_model_field_to_claude_model() {
        // Pre-slice-3 configs stored the Claude model as
        // just `model` — serde alias picks it up.
        let json = r#"{"provider":"claude","claude_lane":"api-key","model":"claude-opus-4-8"}"#;
        let cfg: AssistantConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.claude_model.as_deref(), Some("claude-opus-4-8"));
    }

    #[test]
    fn config_roundtrips_ollama_model() {
        let cfg = AssistantConfig {
            provider: "ollama".into(),
            claude_lane: ClaudeLane::None,
            claude_model: None,
            ollama_model: Some("llama3.1".into()),
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: AssistantConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.provider, "ollama");
        assert_eq!(back.ollama_model.as_deref(), Some("llama3.1"));
    }
}
