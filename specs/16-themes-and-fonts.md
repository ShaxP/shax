# 16 Themes and fonts

The daily-driver polish M10 owes users. M7 shipped a binary light / dark / system toggle wired to one hand-tuned palette; this milestone turns that into a real theming system with a curated catalog, and lets the user pick a monospace font family / size / ligatures setting that drives both xterm and the code viewer.

Grows out of `13-design.md` (the token palette M1.5 defined) and `11-tech-stack-and-conventions.md` (font choice pins). This spec is the shape one level up: how tokens become presets, how presets become the live theme, and where fonts fit.

## What a theme is (and isn't)

- A **theme** is a set of colour values: an ANSI 16-colour palette xterm.js consumes plus a chrome palette rendered as CSS custom properties. Purely data.
- A theme carries a **mode** (`light` or `dark`) and an **id** that identifies it in preferences and picker UIs.
- A theme is **not** layout, spacing, typography choice, or component structure. Those are token defaults from `13`. A theme swap moves colour, not geometry.
- A theme is **not** user-authored in v1. The catalog is embedded in the app bundle as JSON. A future community-drop-in mechanism (`~/.config/shax/themes/<id>/theme.json`) is called out in `12` — deferred, not designed here.

## What a font is (and isn't)

- A **font** is a monospace typeface applied to xterm output **and** the CodeMirror code viewer (`06`). Both surfaces share the setting so raw output and rendered code stay visually coherent.
- Fonts include a **family** (a face bundled with the app or a system-installed name), a **size** in pixels, and a **ligatures** on/off flag.
- Font is **not** applied to the app chrome — menus, buttons, labels, the search overlay, the assistant dock — which keeps the OS system UI font. Monospace chrome reads as programmer-terminal-nostalgia, not daily driver.
- Font is **global**, not per-pane. Zoom (per-pane font-size override) is a separate feature; deferred.

## What the preferences model looks like

The existing `Preferences::theme: ThemePreference { Dark | Light | System }` (from M7) evolves into an `appearance` block:

```
Preferences.appearance = {
  theme_mode:   System | Light | Dark,       // as today, kept for back-compat
  theme_light:  ThemeId,                     // preset used in Light or in System-when-OS-is-light
  theme_dark:   ThemeId,                     // preset used in Dark or in System-when-OS-is-dark
  font_family:  Option<String>,              // None = built-in default (JetBrains Mono)
  font_size:    u8,                          // 10..=24, clamped on write
  ligatures:    bool,
  window_decorations: System | None,         // native OS title bar; default is platform-dependent
}
```

`window_decorations` is the one field whose default is not uniform: `None` on Linux, `System` everywhere else. A tiling compositor (Hyprland, sway, i3, river, niri) places windows itself and draws no server-side decoration, so the GTK client-side title bar duplicates the compositor's own bar and costs ~40px for a set of buttons — minimise, maximise, close — that the compositor already binds to keys. Linux users on a floating desktop set `System` to get them back. On macOS `System` is effectively mandatory: `tauri.conf.json` opts into `titleBarStyle: "Overlay"` so the traffic lights float over the webview, and the chrome row reserves a left inset for them, so an undecorated macOS window would lose the lights and keep the gap. The setting is therefore only offered in the UI on Linux.

Migration: an old `preferences.json` with just `{ "theme": "dark" }` deserialises with `theme_mode = Dark`, `theme_light = shax-light-default`, `theme_dark = shax-dark-default`, and default font settings. No user action required. `#[serde(default)]` on every field, same tolerance rule as the rest of `preferences.rs`.

## Applying a theme

Two paths change at once when the resolved theme changes:

1. **xterm.js**: `Terminal.options.theme` gets the new palette (16 ANSI + `foreground` / `background` / `cursor` / `selectionBackground`). No terminal rebuild — the option is mutable and takes effect on the next redraw.
2. **Chrome**: the theme's chrome palette is written as CSS custom properties on `:root` (`--shax-bg`, `--shax-fg`, `--shax-accent`, `--shax-border`, `--shax-status-ok`, etc.). Existing components already read tokens from `src/theme/tokens.css` (M1.5); the M10 change is that the values come from the active preset instead of a hand-coded palette.

**Resolving the theme choice.** A small pure function `resolveTheme(mode, systemMatch, themeLight, themeDark) → ThemeId`:

- `mode == Light` → `themeLight`
- `mode == Dark`  → `themeDark`
- `mode == System` → `systemMatch == "dark" ? themeDark : themeLight`

`systemMatch` comes from `window.matchMedia('(prefers-color-scheme: dark)')`, whose `change` event drives live re-resolution in System mode. No re-render tricks — the resolved id feeds a React context, the context change re-runs the two application paths above.

## Applying a font

- **xterm.js**: `Terminal.options.fontFamily` + `.fontSize`. Ligatures require the `xterm-addon-ligatures` addon toggled at bind time; on toggle we detach and re-attach. Font-metric changes invalidate cached cell size, so every font change is followed by a `fit()` call from `xterm-addon-fit` — otherwise the shell sees the same rows/cols with a differently-sized cell and lines wrap wrong.
- **CodeMirror**: the editor mounts with `EditorView.theme({ '&': { fontFamily, fontSize } })`. Font changes swap the theme extension.
- **Bundled fonts**: JetBrains Mono, Fira Code, Cascadia Code, and Iosevka ship under OFL 1.1 as `.woff2` in the resource dir. Each is declared via a single `@font-face` block in `src/theme/fonts.css`. System-installed families (Menlo, Consolas, Monaco, etc.) work as `font_family` values too — the CSS falls back through a stack ending in `monospace`.

## The preset catalog

Built-in themes for v1. Each ships as a JSON file under `src-tauri/assets/themes/<id>.json` and is embedded via `include_str!` into a static registry at load time. The frontend receives the parsed catalog on first IPC read and caches it for the session.

- **Shax Dark** (default) — the current M1.5 dark palette, promoted verbatim.
- **Shax Light** — the current M7 light palette, promoted verbatim.
- **Catppuccin** — Latte, Frappé, Macchiato, Mocha (one light, three dark).
- **Solarized** — Light, Dark.
- **Dracula** — dark.
- **Gruvbox** — Light, Dark.
- **Nord** — dark.
- **Tokyo Night** — dark.
- **Phosphor** — Amber, Green, White. Terminal-only CRT recreations; ignore the chrome palette and force the entire UI to the phosphor colour with a subtle scanline background — deliberate retro toggle rather than a serious daily driver.

Every preset is licensed for redistribution under its upstream terms; each JSON file carries a `source` + `license` field the About screen surfaces.

## The things that actually bite, in order

1. **Font metric invalidation.** xterm caches cell dimensions. A font family change without a `fit()` leaves the shell believing it has the old rows/cols; long output lines wrap at the wrong column and TUIs (vim, htop) draw off-grid. Every font path — family, size, ligatures — must funnel through the same "swap options → fit → resize PTY" sequence.
2. **Ligature addon lifecycle.** `xterm-addon-ligatures` isn't a pure config flip; it attaches an addon that intercepts render. Toggling means dispose-old, attach-new. Getting the order wrong leaves ghost renderers active — visible as double-drawn characters. One `useEffect` owns the addon lifetime.
3. **System-mode change during an open session.** The user toggles OS-level dark mode mid-session. `matchMedia` fires; the resolved theme flips; both paths run. Any component that snapshotted colours into local state (screenshots, exports) will hold stale values. Rule: never snapshot theme values; always read live.
4. **Preset id stability.** Ids in the catalog (`shax-dark`, `catppuccin-mocha`, ...) are persisted in preferences. Renaming an id in a later release orphans users' choice and silently reverts them to defaults. Ids are a contract; treat them like schema.
5. **Phosphor's chrome override.** Phosphor themes intentionally overwrite the chrome palette with the terminal colour. That means normal chrome-token tests (contrast ratios, accent colours) don't hold for phosphor. The active-theme colour resolver flags phosphor and skips those checks; component tests that assert on specific chrome colours skip when phosphor is loaded.
6. **Bundled-font size.** Four full font families is real bytes (~1–2 MB each in `.woff2` for the regular / bold / italic set we need). Only ship the subset ranges we actually use (Latin + common symbols) — full Cyrillic + CJK coverage adds an order of magnitude for near-zero benefit in a terminal.

## Interaction with existing surfaces

- **Preferences pane (`13`).** Gains an **Appearance** section: theme picker (mode + preset for light + preset for dark), font family dropdown, font size slider (10–24), ligatures toggle. Live preview — every change applies immediately, no Save / Cancel affordance.
- **Design tokens (`13`).** The token palette becomes the *default* preset (`shax-dark`, `shax-light`), not a competing source of truth. Components continue to read `var(--shax-*)`; the values are now preset-driven.
- **Assistant dock (`09`).** Uses chrome tokens, so it reskins automatically. Its own font (used for prose, not code) stays system UI; code fences inside assistant responses do adopt the chosen monospace font.
- **File viewer (`06`).** CodeMirror pulls the chosen font. Its syntax colours are theme-driven — every preset ships syntax colours (keyword / string / comment / number / type) alongside chrome + ANSI.
- **Search overlay (`05`).** Chrome-only, reskins automatically. Match highlight colours are theme-driven (each preset ships a match colour).
- **Safety-gate modal (`10`).** Chrome-only, reskins automatically. Warning red / caution amber are theme-driven — every preset ships those two colours so accessibility never depends on the palette author caring.

## Slice map

Four slices. Each one is landable independently.

- **M10.1 — Model + catalog loader.** Extend `Preferences` with the `appearance` block plus migration test. Define the theme JSON schema. Ship the embedded catalog above. Backend IPC `list_themes()` returns the catalog. No frontend wiring yet.
- **M10.2 — Live theme application.** React `ThemeProvider` wraps the app. `resolveTheme` + `matchMedia` listener. xterm's `options.theme` updates on preset change; CSS custom properties on `:root` update in the same effect. The M7 light/dark toggle rewires to use `theme_mode` instead of the old boolean.
- **M10.3 — Fonts.** Bundle four OFL font families as `.woff2` resources with `@font-face` declarations. Wire `font_family` / `font_size` / `ligatures` through to xterm (with `fit()`) and to CodeMirror. Ligature addon lifecycle owned by a single hook.
- **M10.4 — Preferences pane Appearance section.** Theme picker (segmented mode selector + two preset dropdowns), font family dropdown, size slider, ligatures toggle. Every input writes preferences and applies live; no save button.

## Explicitly out of scope

- **Per-pane font size** (zoom in / out). Real feature, but distinct — a pane's font size is a runtime state, not a preference. Wait for demand.
- **Community theme drop-in** (`~/.config/shax/themes/<id>/theme.json`). Roadmap material (`12`); a further milestone once the preset engine has settled.
- **Theme-aware images / icons.** SVG icons that recolour with the theme already do so via `currentColor`; bitmap assets that need light / dark variants (screenshots in help, etc.) are covered by design tokens with `prefers-color-scheme` media queries, not this milestone.
- **Per-window theme.** One window per theme feels novel; in practice every user we've talked to wants their choice to follow them across every window. If a real request surfaces, revisit as a per-window override on top of the global preference.
- **Font ligatures on the assistant dock's prose.** Assistant prose uses the system UI font. Ligatures apply to code (xterm + CodeMirror) only.

## Cross-references

- `06-file-viewer.md` — CodeMirror's font wiring.
- `09-ai-assistant-and-auth.md` — chrome-token coverage; code fences pick up the mono font.
- `10-safety-and-permissions.md` — warning / caution colour surface every preset must ship.
- `11-tech-stack-and-conventions.md` — pins JetBrains Mono as the default face; extended here to a bundled family list.
- `12-roadmap-milestones.md` — the deferred community-drop-in mechanism lives in the roadmap seed.
- `13-design.md` — token palette, promoted from the hand-coded source of truth to the default preset.
