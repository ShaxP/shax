//! Built-in theme catalog (M10.1).
//!
//! A theme is a set of colour values plus its identifying metadata.
//! Every preset ships as a JSON file under `src-tauri/assets/themes/`,
//! embedded into the binary at compile time via `include_str!`. No
//! filesystem reads at runtime — the catalog is a fixed compile-time
//! constant, parsed once on first access and cached in a `OnceLock`.
//!
//! Community drop-in (`~/.config/shax/themes/<id>/theme.json`) is
//! called out in `specs/16-themes-and-fonts.md` as explicitly out of
//! scope for M10.1 — deferred to a follow-up milestone so schema
//! versioning + filesystem-watch UX don't slow this slice.
//!
//! See `specs/16-themes-and-fonts.md`.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// Which appearance-mode a theme belongs to. Drives the
/// "which preset counts as 'light'" and "which preset counts
/// as 'dark'" pickers in the preferences pane (M10.4). A
/// theme belongs to exactly one mode — themes with two
/// variants (Catppuccin, Solarized, Gruvbox) ship as two
/// separate presets, not one preset with a mode toggle.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    Light,
    Dark,
}

/// Terminal-surface colours consumed by xterm.js.
///
/// Field names match xterm's `ITheme` option keys so the
/// M10.2 wiring can spread the struct straight in. `ansi`
/// carries the 16 SGR colours the parser resolves for
/// palette-indexed spans.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalPalette {
    pub foreground: String,
    pub background: String,
    pub cursor: String,
    #[serde(rename = "selectionBackground")]
    pub selection_background: String,
    pub ansi: AnsiPalette,
}

/// The 16 ANSI SGR colours (30-37 + 90-97, and the
/// matching background codes). Names match the tokens the
/// frontend already carries in `src/theme/tokens.css`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnsiPalette {
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,
    #[serde(rename = "brightBlack")]
    pub bright_black: String,
    #[serde(rename = "brightRed")]
    pub bright_red: String,
    #[serde(rename = "brightGreen")]
    pub bright_green: String,
    #[serde(rename = "brightYellow")]
    pub bright_yellow: String,
    #[serde(rename = "brightBlue")]
    pub bright_blue: String,
    #[serde(rename = "brightMagenta")]
    pub bright_magenta: String,
    #[serde(rename = "brightCyan")]
    pub bright_cyan: String,
    #[serde(rename = "brightWhite")]
    pub bright_white: String,
}

/// Syntax-highlighting colours applied to the CodeMirror
/// file viewer (`06`), `highlight.js` output inside the
/// assistant dock and markdown viewer, AND (M12.5) the
/// prompt-strip's live tokenizer. hljs-style names cover
/// the editor cases; the five `command` / `subcommand` /
/// `flag` / `variable` / `operator` fields carry the shell-
/// specific kinds the prompt tokenizer emits. `string` and
/// `comment` are reused across both surfaces so a green
/// string in a Rust file matches a green quoted arg in
/// the prompt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyntaxPalette {
    pub comment: String,
    pub keyword: String,
    pub string: String,
    pub number: String,
    pub literal: String,
    pub builtin: String,
    pub name: String,
    pub title: String,
    #[serde(rename = "type")]
    pub type_: String,
    // ── Prompt-strip shell tokenizer (M12.5) ────────────────
    /// The first word on a compound (`ls`, `git`, `echo`).
    pub command: String,
    /// The second word when the first is a known multi-tool
    /// (`git commit`, `docker run`).
    pub subcommand: String,
    /// Any word starting with `-` (`-la`, `--color=auto`).
    pub flag: String,
    /// `$name`, `${…}`, `$?`, `$0`..`$9`.
    pub variable: String,
    /// Pipeline / redirect / grouping glyphs — `|`, `&&`,
    /// `||`, `;`, `>`, `>>`, `<`, `<<`, `(`, `)`.
    pub operator: String,
}

/// A complete theme preset. `chrome` is a free-form
/// map because the set of CSS custom properties the app
/// exposes will grow over time — a fixed struct would
/// force every preset to be edited on every new token.
/// Presets are validated at load time (see `parse`) to
/// ensure the well-known chrome keys are present.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Theme {
    pub id: String,
    pub name: String,
    pub mode: ThemeMode,
    pub source: String,
    pub license: String,
    pub chrome: BTreeMap<String, String>,
    pub terminal: TerminalPalette,
    pub syntax: SyntaxPalette,
    pub warning: String,
    pub caution: String,
    #[serde(rename = "match")]
    pub match_: String,
}

/// Preset id → embedded JSON. Adding a preset means adding
/// a `(id, include_str!("..."))` entry AND the file itself
/// under `assets/themes/`. The `id` in this list MUST match
/// the `id` field inside the JSON (checked in tests) so
/// there's a single source of truth for preset ids.
const EMBEDDED_THEMES: &[(&str, &str)] = &[
    ("shax-dark", include_str!("../assets/themes/shax-dark.json")),
    (
        "shax-light",
        include_str!("../assets/themes/shax-light.json"),
    ),
    (
        "catppuccin-latte",
        include_str!("../assets/themes/catppuccin-latte.json"),
    ),
    (
        "catppuccin-frappe",
        include_str!("../assets/themes/catppuccin-frappe.json"),
    ),
    (
        "catppuccin-macchiato",
        include_str!("../assets/themes/catppuccin-macchiato.json"),
    ),
    (
        "catppuccin-mocha",
        include_str!("../assets/themes/catppuccin-mocha.json"),
    ),
    (
        "solarized-light",
        include_str!("../assets/themes/solarized-light.json"),
    ),
    (
        "solarized-dark",
        include_str!("../assets/themes/solarized-dark.json"),
    ),
    ("dracula", include_str!("../assets/themes/dracula.json")),
    (
        "gruvbox-light",
        include_str!("../assets/themes/gruvbox-light.json"),
    ),
    (
        "gruvbox-dark",
        include_str!("../assets/themes/gruvbox-dark.json"),
    ),
    ("nord", include_str!("../assets/themes/nord.json")),
    (
        "tokyo-night",
        include_str!("../assets/themes/tokyo-night.json"),
    ),
    ("retro-82", include_str!("../assets/themes/retro-82.json")),
    (
        "phosphor-amber",
        include_str!("../assets/themes/phosphor-amber.json"),
    ),
    (
        "phosphor-green",
        include_str!("../assets/themes/phosphor-green.json"),
    ),
    (
        "phosphor-white",
        include_str!("../assets/themes/phosphor-white.json"),
    ),
];

/// Default preset id used for the `light` slot in
/// `AppearancePreferences`. Kept here so
/// `preferences.rs` doesn't hard-code a string that
/// might drift out of the catalog.
pub const DEFAULT_LIGHT_THEME_ID: &str = "shax-light";

/// Default preset id used for the `dark` slot in
/// `AppearancePreferences`.
pub const DEFAULT_DARK_THEME_ID: &str = "shax-dark";

static CATALOG: OnceLock<Vec<Theme>> = OnceLock::new();

/// Parsed catalog of every built-in preset, oldest first.
/// Panics at process start if any embedded JSON fails to
/// parse — that's a build-time bug, not a runtime error,
/// so a bad preset should never ship past CI (see the
/// test module).
pub fn catalog() -> &'static [Theme] {
    CATALOG.get_or_init(|| {
        let mut out = Vec::with_capacity(EMBEDDED_THEMES.len());
        for (expected_id, raw) in EMBEDDED_THEMES {
            let theme: Theme = serde_json::from_str(raw)
                .unwrap_or_else(|e| panic!("embedded theme {expected_id:?} failed to parse: {e}"));
            assert_eq!(
                &theme.id, expected_id,
                "theme file id {:?} disagrees with registry id {:?}",
                theme.id, expected_id
            );
            out.push(theme);
        }
        out
    })
}

/// Look up a preset by id. `None` if the id isn't in the
/// catalog — the caller is responsible for falling back to
/// a sensible default (usually via
/// `DEFAULT_DARK_THEME_ID` / `DEFAULT_LIGHT_THEME_ID`).
///
/// `#[allow(dead_code)]` because M10.1 ships only the model +
/// loader; M10.2 will consume this from the theme resolver to
/// turn a preset id into the palette to apply to xterm and the
/// CSS custom properties. Also exercised in the M10.1 tests.
#[allow(dead_code)]
pub fn get(id: &str) -> Option<&'static Theme> {
    catalog().iter().find(|t| t.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// Every embedded JSON must parse — catches a malformed
    /// preset before it ships. Also guards against a preset
    /// file being present but not registered (or vice versa)
    /// via the id-match assertion inside `catalog()`.
    #[test]
    fn every_embedded_preset_parses() {
        let catalog = catalog();
        assert_eq!(
            catalog.len(),
            EMBEDDED_THEMES.len(),
            "catalog length must match EMBEDDED_THEMES registry"
        );
    }

    #[test]
    fn preset_ids_are_unique() {
        let mut seen = HashSet::new();
        for theme in catalog() {
            assert!(
                seen.insert(theme.id.clone()),
                "duplicate preset id {:?}",
                theme.id
            );
        }
    }

    #[test]
    fn default_ids_resolve() {
        assert!(get(DEFAULT_DARK_THEME_ID).is_some());
        assert!(get(DEFAULT_LIGHT_THEME_ID).is_some());
        assert_eq!(get(DEFAULT_DARK_THEME_ID).unwrap().mode, ThemeMode::Dark);
        assert_eq!(get(DEFAULT_LIGHT_THEME_ID).unwrap().mode, ThemeMode::Light);
    }

    /// Parse the colour syntaxes the presets actually use: `#rrggbb`
    /// and `oklch(L C H)` (the Shax presets express their accents in
    /// oklch). Returns linear-light sRGB components.
    fn parse_color(raw: &str) -> Option<[f64; 3]> {
        let raw = raw.trim();
        if let Some(hex) = raw.strip_prefix('#') {
            if hex.len() != 6 {
                return None;
            }
            let ch = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
            return Some([
                f64::from(ch(0)?) / 255.0,
                f64::from(ch(2)?) / 255.0,
                f64::from(ch(4)?) / 255.0,
            ]);
        }
        let inner = raw.strip_prefix("oklch(")?.trim_end_matches(')');
        // `L C H` optionally followed by `/ alpha`, which we ignore —
        // these are opaque surfaces.
        let head = inner.split('/').next()?;
        let mut parts = head.split_whitespace();
        let l: f64 = parts.next()?.parse().ok()?;
        let c: f64 = parts.next()?.parse().ok()?;
        let h: f64 = parts.next()?.parse().ok()?;
        let (a, b) = (c * h.to_radians().cos(), c * h.to_radians().sin());
        let l_ = (l + 0.396_337_777_4 * a + 0.215_803_757_3 * b).powi(3);
        let m_ = (l - 0.105_561_345_8 * a - 0.063_854_172_8 * b).powi(3);
        let s_ = (l - 0.089_484_177_5 * a - 1.291_485_548_0 * b).powi(3);
        let lin = [
            4.076_741_662_1 * l_ - 3.307_711_591_3 * m_ + 0.230_969_929_2 * s_,
            -1.268_438_004_6 * l_ + 2.609_757_401_1 * m_ - 0.341_319_396_5 * s_,
            -0.004_196_086_3 * l_ - 0.703_418_614_7 * m_ + 1.707_614_701_0 * s_,
        ];
        // Back to gamma-encoded sRGB so both syntaxes reach
        // `relative_luminance` in the same space.
        let enc = |v: f64| {
            let v = v.clamp(0.0, 1.0);
            if v <= 0.003_130_8 {
                12.92 * v
            } else {
                1.055 * v.powf(1.0 / 2.4) - 0.055
            }
        };
        Some([enc(lin[0]), enc(lin[1]), enc(lin[2])])
    }

    /// WCAG 2.1 relative luminance.
    fn relative_luminance(srgb: [f64; 3]) -> f64 {
        let lin = |c: f64| {
            if c <= 0.040_45 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * lin(srgb[0]) + 0.7152 * lin(srgb[1]) + 0.0722 * lin(srgb[2])
    }

    fn contrast_ratio(a: [f64; 3], b: [f64; 3]) -> f64 {
        let (la, lb) = (relative_luminance(a), relative_luminance(b));
        let (hi, lo) = if la > lb { (la, lb) } else { (lb, la) };
        (hi + 0.05) / (lo + 0.05)
    }

    /// Each `<surface>-fg` is the ink for text sitting ON that surface
    /// when it is used as a *background*:
    ///
    /// - `accent-fg` — the mode pill, the calendar's today chip, every
    ///   primary and approve button.
    /// - `green-fg` — the assistant's read-only "Run" probe button.
    /// - `red-fg` — the safety gate's "Run anyway" and the assistant's
    ///   destructive proposal.
    ///
    /// Before these tokens the codebase had three different answers —
    /// `#fff`, `--fg`, `--bg` — none theme-aware. White failed WCAG AA
    /// on 14 of 17 presets over `--green` and 12 of 17 over `--red`,
    /// bottoming out at 1.14:1 (Phosphor White's green) and 1.31:1
    /// (Phosphor Green's red). The red ones front destructive actions,
    /// so this is a safety property, not only an aesthetic one.
    ///
    /// The right ink is genuinely per-theme *and* per-surface: 5 presets
    /// want a LIGHT ink on `--red` (Solarized's red is dark enough that
    /// white wins) while wanting a dark one on `--accent`. That is why
    /// there are three tokens rather than one reused everywhere —
    /// reusing `accent-fg` would regress Nord red 4.09 -> 3.56.
    ///
    /// Pinning the invariant here means a new preset cannot ship an
    /// illegible chip, and nobody can "tidy" one of these back to a
    /// foreground colour without CI saying so.
    #[test]
    fn surface_inks_are_legible_in_every_preset() {
        for theme in catalog() {
            for surface in ["accent", "green", "red"] {
                let ink_key = format!("{surface}-fg");
                let bg = theme
                    .chrome
                    .get(surface)
                    .unwrap_or_else(|| panic!("{}: missing {surface}", theme.id));
                let ink = theme
                    .chrome
                    .get(&ink_key)
                    .unwrap_or_else(|| panic!("{}: missing {ink_key}", theme.id));
                let b = parse_color(bg)
                    .unwrap_or_else(|| panic!("{}: cannot parse {surface} {bg}", theme.id));
                let f = parse_color(ink)
                    .unwrap_or_else(|| panic!("{}: cannot parse {ink_key} {ink}", theme.id));
                let ratio = contrast_ratio(b, f);
                assert!(
                    ratio >= 4.5,
                    "{}: {ink_key} {ink} on {surface} {bg} is {ratio:.2}:1, below the WCAG AA \
                     minimum of 4.5:1 for normal text",
                    theme.id,
                );
            }
        }
    }

    #[test]
    fn every_preset_ships_required_chrome_keys() {
        // These are the CSS custom properties currently
        // consumed by `src/theme/tokens.css`. New keys added
        // to tokens.css should be added here so a preset
        // that forgets one fails CI, not the frontend.
        const REQUIRED: &[&str] = &[
            "bg",
            "pane",
            "pane2",
            "surface",
            "surface-hover",
            "titlebar",
            "border",
            "border-strong",
            "fg",
            "fg-dim",
            "fg-faint",
            "accent",
            "accent-soft",
            "accent-fg",
            "green",
            "green-fg",
            "red",
            "red-fg",
            "amber",
            "cyan",
            "magenta",
            "checkerboard",
        ];
        for theme in catalog() {
            for key in REQUIRED {
                assert!(
                    theme.chrome.contains_key(*key),
                    "preset {:?} missing required chrome key {:?}",
                    theme.id,
                    key
                );
            }
        }
    }

    #[test]
    fn shax_dark_matches_tokens_css() {
        // Guards the "M1.5 palette promoted verbatim" claim
        // in the spec — a drift here means the default
        // preset has diverged from `src/theme/tokens.css`.
        let t = get("shax-dark").unwrap();
        assert_eq!(t.chrome.get("bg").map(String::as_str), Some("#0c0d10"));
        assert_eq!(t.chrome.get("pane").map(String::as_str), Some("#0e0f13"));
        assert_eq!(t.chrome.get("fg").map(String::as_str), Some("#d8dbe2"));
        assert_eq!(t.terminal.ansi.red, "#e05561");
    }

    #[test]
    fn shax_light_matches_tokens_css() {
        let t = get("shax-light").unwrap();
        assert_eq!(t.chrome.get("bg").map(String::as_str), Some("#fafaf7"));
        assert_eq!(t.chrome.get("pane").map(String::as_str), Some("#ffffff"));
        assert_eq!(t.chrome.get("fg").map(String::as_str), Some("#1a1c22"));
    }

    #[test]
    fn get_unknown_returns_none() {
        assert!(get("this-preset-does-not-exist").is_none());
    }
}
