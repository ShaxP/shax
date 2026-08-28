//! Shell-side expansion for the `ls` formatter's positional argument.
//!
//! Shax's block-capture keeps the pre-expansion command text (see
//! `BlockRow.tsx` → `shellTokenize(block.command)`), so shell expansions
//! reach the formatter unresolved. Client-side we don't know the caller's
//! `$HOME`, don't have `getpwnam`, and don't ship a glob engine. Without
//! the shell's help, `ls ~/Downloads`, `ls $HOME`, and `ls *.ts` all
//! resolve to literal-path probes and fail (either ENOENT for an
//! unresolvable pattern, or an unfiltered dump for a stripped-to-parent
//! fallback).
//!
//! `resolve_ls_arg(cwd, path_arg)` does the missing work in Rust:
//!
//!   1. `shellexpand::full` handles tilde (`~`, `~user`) and parameter
//!      (`$VAR`, `${VAR}`) expansion. Unknown env vars return `Err`,
//!      which surfaces as `parent_dir: None` on the wire — the client
//!      then falls through to raw for that block.
//!   2. If the expanded token contains a glob metachar, we run
//!      `glob::glob` against its absolutised form and return the list
//!      of matching basenames as `filter_names`, alongside their
//!      common parent as `parent_dir`. The client probes that parent
//!      with `read_dir_entries` and filters the entry list to just the
//!      matched names before applying `-a`/sort.
//!
//! Braces (`{a,b}`) are NOT expanded here — `shellexpand::full` doesn't
//! do them, `glob` doesn't do them, and pulling in a third dependency
//! for this one case is disproportionate. A path with `{` returns
//! `parent_dir: None`; the client falls through to raw for that block.
//!
//! Cross-parent matches (e.g. `src/*/foo.rs` where matches live in
//! several sibling `src/<x>/foo.rs` directories) also return
//! `parent_dir: None`: the frontend renders one directory at a time
//! and there's no honest single directory to name here. Raw output
//! is the truthful fallback (fidelity contract, spec §07 rule 2).

use std::path::{Path, PathBuf};

/// The result of resolving one `ls` positional argument.
#[derive(Debug, serde::Serialize, PartialEq, Eq)]
pub struct ResolveResult {
    /// Absolute path the client should probe with `read_dir_entries`.
    /// `None` when the token can't be resolved from this process's
    /// environment (undefined env var, unrecognised `~user`, braces,
    /// cross-parent glob) — the client PASSes to raw for that block.
    pub parent_dir: Option<String>,
    /// Basenames within `parent_dir` that the glob pattern matched.
    /// `None` means "no glob — show every entry in `parent_dir`".
    /// `Some(empty)` means "glob evaluated to zero matches" — the
    /// client renders an empty listing rather than mis-attributing
    /// the empty state to a filesystem error.
    pub filter_names: Option<Vec<String>>,
}

impl ResolveResult {
    const UNRESOLVABLE: ResolveResult = ResolveResult {
        parent_dir: None,
        filter_names: None,
    };
}

/// The Tauri command surface. Kept a thin wrapper so the pure resolver
/// can be exercised in unit tests without a Tauri runtime.
#[tauri::command]
pub async fn resolve_ls_arg(cwd: String, path_arg: String) -> ResolveResult {
    resolve(&cwd, &path_arg)
}

/// The pure resolver. See the module docstring for the algorithm.
pub fn resolve(cwd: &str, path_arg: &str) -> ResolveResult {
    // Step 1: tilde + parameter expansion. Run this BEFORE the brace
    // check so `${VAR}` — parameter-expansion syntax that happens to
    // contain a brace — resolves cleanly rather than tripping the
    // "no braces supported" guard. After expansion, any brace left in
    // the string is a genuine brace-expansion pattern.
    let expanded = match shellexpand::full(path_arg) {
        Ok(cow) => cow.into_owned(),
        Err(_) => return ResolveResult::UNRESOLVABLE,
    };

    // Braces: shellexpand::full doesn't expand `{a,b}` and neither
    // does the glob crate. Rather than mis-report, defer to raw.
    if expanded.contains('{') {
        return ResolveResult::UNRESOLVABLE;
    }

    // Step 2: does the expanded token contain a glob metachar?
    let has_glob = expanded.contains('*') || expanded.contains('?') || expanded.contains('[');

    if !has_glob {
        // Plain path — client probes it directly.
        return ResolveResult {
            parent_dir: Some(absolutise(cwd, &expanded)),
            filter_names: None,
        };
    }

    // Step 3: glob evaluation against the absolute pattern.
    //
    // `require_literal_leading_dot: true` matches bash/zsh default
    // globbing: `*` does NOT match dotfiles. Our own `-a` client
    // flag is what un-hides them (via `applyLsView`), applied on
    // top of the filter — same layering as bare `ls -a`.
    let abs_pattern = absolutise(cwd, &expanded);
    let match_options = glob::MatchOptions {
        require_literal_leading_dot: true,
        ..Default::default()
    };
    let paths: Vec<PathBuf> = match glob::glob_with(&abs_pattern, match_options) {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(_) => {
            // Malformed pattern (unmatched `[` etc). Defer to raw so the
            // shell's own error output stands.
            return ResolveResult::UNRESOLVABLE;
        }
    };

    // Zero matches → still hand back the pattern's parent so the client
    // renders an empty listing rather than an error.
    if paths.is_empty() {
        let parent = strip_glob_to_parent(&abs_pattern);
        return ResolveResult {
            parent_dir: Some(parent),
            filter_names: Some(Vec::new()),
        };
    }

    // Group by parent. The client renders one directory at a time, so
    // cross-parent matches (recursive globs, `src/*/foo`) can't be
    // filtered as a basename list — raw is the honest fallback.
    let Some(common) = common_parent(&paths) else {
        return ResolveResult::UNRESOLVABLE;
    };

    let names: Vec<String> = paths
        .iter()
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .collect();

    ResolveResult {
        parent_dir: Some(common.to_string_lossy().into_owned()),
        filter_names: Some(names),
    }
}

/// Join `cwd` with a possibly-relative `path`. Absolute paths are
/// passed through unchanged. Trailing `/` on `cwd` is trimmed so we
/// don't produce `//`.
fn absolutise(cwd: &str, path: &str) -> String {
    if Path::new(path).is_absolute() {
        return path.to_string();
    }
    let base = cwd.trim_end_matches('/');
    if base.is_empty() {
        // cwd was literally `/` — put the path directly under root.
        return format!("/{path}");
    }
    format!("{base}/{path}")
}

/// Given a glob pattern like `/home/me/src/*.ts`, return the parent
/// directory prefix that contains no glob metachar — `/home/me/src`.
/// A pattern with no `/` before its first metachar (e.g. `*.ts` at
/// process root — unusual, but survivable) returns `/`.
fn strip_glob_to_parent(pattern: &str) -> String {
    let idx = pattern.find(['*', '?', '[']).unwrap_or(pattern.len());
    let prefix = &pattern[..idx];
    match prefix.rfind('/') {
        Some(0) => "/".to_string(),
        Some(i) => prefix[..i].to_string(),
        None => "/".to_string(),
    }
}

/// The single parent directory shared by every path in `paths`, or
/// `None` if the paths span multiple parents.
fn common_parent(paths: &[PathBuf]) -> Option<PathBuf> {
    let mut iter = paths.iter().filter_map(|p| p.parent());
    let first = iter.next()?.to_path_buf();
    for p in iter {
        if p != first.as_path() {
            return None;
        }
    }
    Some(first)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    // The path-shape tests below assume Unix-style absolute paths
    // (leading `/`). On Windows `Path::is_absolute("/etc")` returns
    // false — Windows expects `C:\…` — so `absolutise` would
    // concatenate cwd + "/etc" instead of returning "/etc" verbatim.
    // The code is correct per-platform; the tests are Unix-shaped by
    // choice because Shax's shell-typed argv is expected to be
    // Unix-style (users type `/etc`, `~`, `$HOME` even in a Windows
    // git-bash pane). We gate them with `#[cfg(unix)]` rather than
    // adding a parallel Windows-path suite whose expectations would
    // duplicate `Path::is_absolute`'s own contract.

    // ── Pure helpers (Unix path shapes) ─────────────────────────────

    #[cfg(unix)]
    #[test]
    fn absolutise_passes_absolute_through() {
        assert_eq!(absolutise("/home/me", "/etc/passwd"), "/etc/passwd");
    }

    #[test]
    fn absolutise_joins_relative() {
        assert_eq!(absolutise("/home/me", "src"), "/home/me/src");
        assert_eq!(absolutise("/home/me/proj/", "src"), "/home/me/proj/src");
    }

    #[cfg(unix)]
    #[test]
    fn absolutise_handles_root_cwd() {
        assert_eq!(absolutise("/", "etc"), "/etc");
    }

    #[test]
    fn strip_glob_to_parent_finds_parent() {
        assert_eq!(strip_glob_to_parent("/home/me/src/*.ts"), "/home/me/src");
        assert_eq!(strip_glob_to_parent("/home/me/*.ts"), "/home/me");
        assert_eq!(strip_glob_to_parent("/*.ts"), "/");
        assert_eq!(strip_glob_to_parent("/tmp/dir/*"), "/tmp/dir");
    }

    // ── Full resolver — plain paths ─────────────────────────────────

    #[test]
    fn plain_relative_path_joins_with_cwd() {
        let r = resolve("/home/me", "src");
        assert_eq!(r.parent_dir.as_deref(), Some("/home/me/src"));
        assert_eq!(r.filter_names, None);
    }

    #[cfg(unix)]
    #[test]
    fn plain_absolute_path_survives_cwd() {
        let r = resolve("/home/me", "/etc");
        assert_eq!(r.parent_dir.as_deref(), Some("/etc"));
        assert_eq!(r.filter_names, None);
    }

    // ── Tilde + env expansion ──────────────────────────────────────

    // `HOME` is a Unix convention (`USERPROFILE` on Windows); a Windows
    // shell that types `~` typically means the git-bash flavour where
    // `HOME` is set, but standard PowerShell / cmd don't set it. Rather
    // than fake `HOME` on Windows for the test, gate to Unix — the
    // behaviour on Windows falls out of `shellexpand::tilde_with_context`,
    // which is upstream's contract.
    #[cfg(unix)]
    #[test]
    fn tilde_expands_to_home() {
        let home = std::env::var("HOME").expect("HOME env var required for test");
        let r = resolve("/tmp", "~");
        assert_eq!(r.parent_dir.as_deref(), Some(home.as_str()));
        assert_eq!(r.filter_names, None);
    }

    #[cfg(unix)]
    #[test]
    fn tilde_with_subpath_expands() {
        let home = std::env::var("HOME").expect("HOME env var required for test");
        let r = resolve("/tmp", "~/Downloads");
        assert_eq!(r.parent_dir.unwrap(), format!("{home}/Downloads"));
    }

    #[cfg(unix)]
    #[test]
    fn env_var_expands() {
        // Set a deterministic env var so this test doesn't depend on
        // the runner's environment. Assertion is Unix-path-shaped;
        // see the block comment above the pure-helper section.
        std::env::set_var("SHAX_LS_TEST_DIR", "/opt/somewhere");
        let r = resolve("/tmp", "$SHAX_LS_TEST_DIR");
        assert_eq!(r.parent_dir.as_deref(), Some("/opt/somewhere"));
    }

    #[cfg(unix)]
    #[test]
    fn env_var_with_braces_expands() {
        std::env::set_var("SHAX_LS_TEST_DIR2", "/opt/two");
        let r = resolve("/tmp", "${SHAX_LS_TEST_DIR2}/sub");
        assert_eq!(r.parent_dir.as_deref(), Some("/opt/two/sub"));
    }

    #[test]
    fn unknown_env_var_returns_unresolvable() {
        // shellexpand::full returns Err when a `$VAR` isn't in the
        // process env — the client falls through to raw for the block.
        let r = resolve("/tmp", "$SHAX_LS_UNDEFINED_VAR_XYZ");
        assert_eq!(r, ResolveResult::UNRESOLVABLE);
    }

    #[test]
    fn braces_return_unresolvable() {
        // Neither shellexpand::full nor glob handles brace expansion;
        // rather than mis-report we defer to raw.
        let r = resolve("/tmp", "{a,b}");
        assert_eq!(r, ResolveResult::UNRESOLVABLE);
        let r = resolve("/tmp", "src/{lib,bin}");
        assert_eq!(r, ResolveResult::UNRESOLVABLE);
    }

    // ── Glob expansion against a real tempdir ──────────────────────

    fn write(path: &Path) {
        fs::write(path, b"").unwrap();
    }

    #[test]
    fn bare_glob_lists_cwd_matches() {
        let td = tempdir().unwrap();
        write(&td.path().join("a.ts"));
        write(&td.path().join("b.ts"));
        write(&td.path().join("c.md"));
        let cwd = td.path().to_string_lossy().into_owned();

        let r = resolve(&cwd, "*.ts");
        assert_eq!(r.parent_dir.as_deref(), Some(cwd.as_str()));
        let mut names = r.filter_names.unwrap();
        names.sort();
        assert_eq!(names, vec!["a.ts".to_string(), "b.ts".to_string()]);
    }

    #[test]
    fn bare_star_matches_every_non_dotfile() {
        let td = tempdir().unwrap();
        write(&td.path().join("a"));
        write(&td.path().join("b"));
        write(&td.path().join(".hidden"));
        let cwd = td.path().to_string_lossy().into_owned();

        let r = resolve(&cwd, "*");
        // glob crate default doesn't match hidden entries (matching
        // bash / zsh's default `*` behaviour). Good — `-a` on the
        // client is still what un-hides them.
        let mut names = r.filter_names.unwrap();
        names.sort();
        assert_eq!(names, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn subdir_glob_lists_matches_under_that_subdir() {
        let td = tempdir().unwrap();
        let sub = td.path().join("src");
        fs::create_dir(&sub).unwrap();
        write(&sub.join("main.ts"));
        write(&sub.join("lib.ts"));
        write(&sub.join("README.md"));
        let cwd = td.path().to_string_lossy().into_owned();

        let r = resolve(&cwd, "src/*.ts");
        assert_eq!(
            r.parent_dir.as_deref(),
            Some(sub.to_string_lossy().as_ref())
        );
        let mut names = r.filter_names.unwrap();
        names.sort();
        assert_eq!(names, vec!["lib.ts".to_string(), "main.ts".to_string()]);
    }

    #[test]
    fn zero_matches_returns_empty_filter_over_parent() {
        // Empty filter is a distinct signal from "no glob" — the client
        // renders "no matches" rather than the full parent listing.
        let td = tempdir().unwrap();
        write(&td.path().join("a.md"));
        let cwd = td.path().to_string_lossy().into_owned();

        let r = resolve(&cwd, "*.ts");
        assert_eq!(r.parent_dir.as_deref(), Some(cwd.as_str()));
        assert_eq!(r.filter_names, Some(Vec::new()));
    }

    #[test]
    fn recursive_glob_across_parents_defers_to_raw() {
        // `src/*/foo` matches `src/a/foo` and `src/b/foo` — different
        // parents. The client can only render one dir at a time, so
        // this defers to raw.
        let td = tempdir().unwrap();
        let a = td.path().join("src/a");
        let b = td.path().join("src/b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        write(&a.join("foo"));
        write(&b.join("foo"));
        let cwd = td.path().to_string_lossy().into_owned();

        let r = resolve(&cwd, "src/*/foo");
        assert_eq!(r, ResolveResult::UNRESOLVABLE);
    }

    #[test]
    fn env_plus_glob_composes() {
        let td = tempdir().unwrap();
        write(&td.path().join("x.ts"));
        write(&td.path().join("y.ts"));
        std::env::set_var(
            "SHAX_LS_TEST_DIR3",
            td.path().to_string_lossy().into_owned(),
        );

        // `$SHAX_LS_TEST_DIR3/*.ts` → env expands, then glob resolves.
        let r = resolve("/tmp", "$SHAX_LS_TEST_DIR3/*.ts");
        assert_eq!(
            r.parent_dir.as_deref(),
            Some(td.path().to_string_lossy().as_ref())
        );
        let mut names = r.filter_names.unwrap();
        names.sort();
        assert_eq!(names, vec!["x.ts".to_string(), "y.ts".to_string()]);
    }
}
