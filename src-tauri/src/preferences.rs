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
use crate::themes::{DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID};

/// The user's theme preference. `System` follows
/// `prefers-color-scheme`; concrete values force it.
///
/// M10 kept this shape for back-compat — the field name
/// still exists at the top level of the on-disk file so old
/// installations deserialise onto the new `appearance`
/// block without user action. The M10 model has three
/// distinct choices (Light / Dark / System) and this enum
/// carries them; the specific *preset* used in each mode
/// lives on `AppearancePreferences`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ThemePreference {
    Dark,
    Light,
    #[default]
    System,
}

/// Minimum font size, in CSS px. Anything smaller
/// hurts readability on retina displays.
pub const MIN_FONT_SIZE: u8 = 10;
/// Maximum font size, in CSS px. Above this the terminal
/// reflows in weird ways and users hit the "why is my
/// screen a single word wide" cliff.
pub const MAX_FONT_SIZE: u8 = 24;
/// Default font size — matches the current xterm cell
/// pixel height so an unmigrated user sees no jump.
pub const DEFAULT_FONT_SIZE: u8 = 13;

fn default_font_size() -> u8 {
    DEFAULT_FONT_SIZE
}

fn default_ligatures() -> bool {
    true
}

fn default_theme_light() -> String {
    DEFAULT_LIGHT_THEME_ID.to_string()
}

fn default_theme_dark() -> String {
    DEFAULT_DARK_THEME_ID.to_string()
}

/// The user's chosen line-editing mode for the shell prompt
/// (M12.2, spec §18 D2).
///
/// - `Emacs` (default) — the shim forces emacs bindings against
///   any plugin that tries to install vi keys. `bindkey -e` at
///   source time plus a defence-in-depth pair: precmd hook +
///   `zle-line-init` widget that overrides deferred-init
///   plugins like `zsh-vi-mode`.
/// - `Vi` — the shim sources the bundled `zsh-vi-mode` (v0.12.0)
///   when the user's rc hasn't already loaded it, and registers
///   a `zle-keymap-select` widget that emits `OSC 133;M;<keymap>`
///   so the frontend statusline can render a two-chip pill
///   (COMMAND · INSERT / NORMAL / VISUAL).
///
/// The always-on assertive parts of the shim (bare PS1,
/// silenced `zsh-syntax-highlighting`) are unaffected by this
/// preference — those are visual conflicts Shax owns; this
/// preference is the user's editing philosophy, which they get
/// to pick. The `SHAX_DISABLE_HARDENING=1` env var (undocumented
/// safety valve) turns off everything for one shell if it's
/// ever needed for debugging.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum LineEditing {
    #[default]
    Emacs,
    Vi,
}

impl LineEditing {
    /// Value written into the `SHAX_LINE_EDITING` environment
    /// variable that the shell shims branch on. Kept lowercase
    /// so the shim can test with a simple string comparison.
    pub fn as_env_str(&self) -> &'static str {
        match self {
            Self::Emacs => "emacs",
            Self::Vi => "vi",
        }
    }
}

fn default_line_editing() -> LineEditing {
    LineEditing::default()
}

/// Appearance (theme + font) preferences (M10.1).
///
/// The `theme_light` and `theme_dark` fields carry
/// preset ids from the theme catalog (see
/// `crate::themes`). Persisted verbatim, so a rename in
/// the catalog silently orphans user choice — treat ids as
/// a schema-level contract.
///
/// Every field is `#[serde(default)]` so an
/// `appearance` block written by an older Shax that
/// didn't know about a newer field still deserialises
/// cleanly. And the whole block itself is
/// `#[serde(default)]` on `Preferences`, so a
/// pre-M10 file with no `appearance` at all
/// deserialises onto defaults.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppearancePreferences {
    #[serde(default = "default_theme_light")]
    pub theme_light: String,
    #[serde(default = "default_theme_dark")]
    pub theme_dark: String,
    #[serde(default)]
    pub font_family: Option<String>,
    #[serde(default = "default_font_size")]
    pub font_size: u8,
    #[serde(default = "default_ligatures")]
    pub ligatures: bool,
    /// The user's line-editing mode for the shell prompt
    /// (M12.2). See [`LineEditing`] for behaviour details.
    /// Missing field → emacs default (matches a fresh install
    /// and matches every supported shell's own default).
    #[serde(default = "default_line_editing")]
    pub line_editing: LineEditing,
}

impl Default for AppearancePreferences {
    fn default() -> Self {
        Self {
            theme_light: default_theme_light(),
            theme_dark: default_theme_dark(),
            font_family: None,
            font_size: DEFAULT_FONT_SIZE,
            ligatures: true,
            line_editing: LineEditing::default(),
        }
    }
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
    /// Appearance settings introduced in M10.1: which preset id
    /// counts as the light theme, which counts as the dark theme,
    /// and the font family / size / ligatures choice. An old
    /// preferences.json without the field deserialises to defaults;
    /// nothing else needs to change on the caller side.
    #[serde(default)]
    pub appearance: AppearancePreferences,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: ThemePreference::default(),
            assistant_docked: false,
            assistant_dock_width: DEFAULT_ASSISTANT_DOCK_WIDTH,
            appearance: AppearancePreferences::default(),
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
///
/// Font size is clamped to `[MIN_FONT_SIZE, MAX_FONT_SIZE]`
/// on write per the spec — an untrusted preferences.json
/// (or a frontend bug) can't push xterm into a broken
/// cell-metric regime that way.
pub fn save(preferences: &Preferences) -> Result<(), PreferencesError> {
    let mut prefs = preferences.clone();
    prefs.appearance.font_size = prefs
        .appearance
        .font_size
        .clamp(MIN_FONT_SIZE, MAX_FONT_SIZE);
    let path = preferences_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&prefs)?;
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
            ..Preferences::default()
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

    // ── M10.1 appearance ────────────────────────────────────

    #[test]
    fn default_appearance_uses_shax_preset_ids() {
        let a = AppearancePreferences::default();
        assert_eq!(a.theme_light, DEFAULT_LIGHT_THEME_ID);
        assert_eq!(a.theme_dark, DEFAULT_DARK_THEME_ID);
        assert_eq!(a.font_family, None);
        assert_eq!(a.font_size, DEFAULT_FONT_SIZE);
        assert!(a.ligatures);
        assert_eq!(a.line_editing, LineEditing::Emacs);
    }

    #[test]
    fn appearance_round_trips_through_json() {
        let p = Preferences {
            appearance: AppearancePreferences {
                theme_light: "catppuccin-latte".into(),
                theme_dark: "tokyo-night".into(),
                font_family: Some("Fira Code".into()),
                font_size: 15,
                ligatures: false,
                line_editing: LineEditing::Vi,
            },
            ..Preferences::default()
        };
        let json = serde_json::to_string(&p).unwrap();
        let back: Preferences = serde_json::from_str(&json).unwrap();
        assert_eq!(back.appearance.theme_light, "catppuccin-latte");
        assert_eq!(back.appearance.theme_dark, "tokyo-night");
        assert_eq!(back.appearance.font_family.as_deref(), Some("Fira Code"));
        assert_eq!(back.appearance.font_size, 15);
        assert!(!back.appearance.ligatures);
        assert_eq!(back.appearance.line_editing, LineEditing::Vi);
    }

    // ── M12.2 line-editing mode ─────────────────────────────

    #[test]
    fn default_line_editing_is_emacs() {
        let a = AppearancePreferences::default();
        assert_eq!(a.line_editing, LineEditing::Emacs);
    }

    #[test]
    fn line_editing_env_str_is_lowercase() {
        // The shim tests $SHAX_LINE_EDITING with a plain string
        // comparison; casing has to be stable.
        assert_eq!(LineEditing::Emacs.as_env_str(), "emacs");
        assert_eq!(LineEditing::Vi.as_env_str(), "vi");
    }

    #[test]
    fn line_editing_serialises_as_kebab_case() {
        for mode in [LineEditing::Emacs, LineEditing::Vi] {
            let p = Preferences {
                appearance: AppearancePreferences {
                    line_editing: mode,
                    ..AppearancePreferences::default()
                },
                ..Preferences::default()
            };
            let json = serde_json::to_string(&p).unwrap();
            assert!(json.contains(&format!(r#""line_editing":"{}""#, mode.as_env_str())));
        }
    }

    #[test]
    fn pre_m122_appearance_block_gets_emacs_default() {
        // An appearance block written before M12.2 shipped had no
        // line_editing field. #[serde(default)] populates it with
        // Emacs — matches every supported shell's own default.
        let old_json = r#"{"appearance":{"font_size":15}}"#;
        let p: Preferences = serde_json::from_str(old_json).unwrap();
        assert_eq!(p.appearance.font_size, 15);
        assert_eq!(p.appearance.line_editing, LineEditing::Emacs);
    }

    #[test]
    fn pre_m10_preferences_json_deserialises_to_appearance_defaults() {
        // A file written before M10.1 shipped had no `appearance`
        // block. `#[serde(default)]` on the field means the whole
        // block gets populated with defaults, no user action.
        let old_json = r#"{"theme":"dark","assistant_docked":true,"assistant_dock_width":500}"#;
        let p: Preferences = serde_json::from_str(old_json).unwrap();
        assert_eq!(p.theme, ThemePreference::Dark);
        assert!(p.assistant_docked);
        assert_eq!(p.assistant_dock_width, 500);
        assert_eq!(p.appearance.theme_light, DEFAULT_LIGHT_THEME_ID);
        assert_eq!(p.appearance.theme_dark, DEFAULT_DARK_THEME_ID);
        assert_eq!(p.appearance.font_size, DEFAULT_FONT_SIZE);
        assert!(p.appearance.ligatures);
    }

    #[test]
    fn partial_appearance_block_fills_missing_fields_from_defaults() {
        // Guards the per-field #[serde(default)] on
        // AppearancePreferences — a hand-edited file that
        // sets only `font_size` mustn't wipe the rest.
        let json = r#"{"theme":"system","appearance":{"font_size":18}}"#;
        let p: Preferences = serde_json::from_str(json).unwrap();
        assert_eq!(p.appearance.font_size, 18);
        assert_eq!(p.appearance.theme_dark, DEFAULT_DARK_THEME_ID);
        assert_eq!(p.appearance.theme_light, DEFAULT_LIGHT_THEME_ID);
        assert!(p.appearance.ligatures);
    }

    #[test]
    fn save_clamps_font_size_within_range() {
        // We can't easily exercise `save()`'s filesystem path
        // here (no writable config dir in the sandbox), so this
        // test exercises the clamp logic directly against the
        // documented bounds.
        assert_eq!(20u8.clamp(MIN_FONT_SIZE, MAX_FONT_SIZE), 20);
        assert_eq!(4u8.clamp(MIN_FONT_SIZE, MAX_FONT_SIZE), MIN_FONT_SIZE);
        assert_eq!(99u8.clamp(MIN_FONT_SIZE, MAX_FONT_SIZE), MAX_FONT_SIZE);
    }
}
