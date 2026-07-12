//! Build script.
//!
//! Two jobs:
//!   1. Run `tauri_build::build()` as any Tauri app does.
//!   2. Fetch the sentence-transformer model + tokenizer used
//!      by the ONNX-backed embedder (M7 slice 2b). Files are
//!      too large for git, so we cache them under
//!      `src-tauri/assets/` on first build. Subsequent builds
//!      are no-ops.
//!
//! Fetch failures degrade gracefully: the app falls back to
//! the `HashEmbedder` at runtime and logs a warning. That
//! keeps CI green and dev machines usable even offline —
//! semantic search just isn't meaningful without the model.

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Xenova's community ONNX conversion of `all-MiniLM-L6-v2`.
/// Quantized int8 variant — ~23 MB, <1% MTEB delta vs f32.
const MODEL_URL: &str =
    "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx";
const TOKENIZER_URL: &str =
    "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer.json";

const MODEL_NAME: &str = "all-MiniLM-L6-v2.onnx";
const TOKENIZER_NAME: &str = "tokenizer.json";

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let assets_dir = manifest_dir.join("assets");
    if let Err(e) = std::fs::create_dir_all(&assets_dir) {
        println!("cargo:warning=failed to create assets dir: {e}");
    }
    fetch_if_missing(&assets_dir.join(MODEL_NAME), MODEL_URL);
    fetch_if_missing(&assets_dir.join(TOKENIZER_NAME), TOKENIZER_URL);
    // Don't force a rebuild every cargo invocation — the
    // fetch is idempotent and the assets don't change unless
    // we explicitly clean them.
    println!("cargo:rerun-if-changed=build.rs");
    tauri_build::build()
}

fn fetch_if_missing(dest: &Path, url: &str) {
    if dest.exists() {
        return;
    }
    println!(
        "cargo:warning=embedder: fetching {url} -> {}",
        dest.display()
    );
    let status = Command::new("curl")
        .args(["-fsSL", "--connect-timeout", "10", "-o"])
        .arg(dest)
        .arg(url)
        .status();
    match status {
        Ok(s) if s.success() => (),
        Ok(s) => {
            // Remove any partial file so we retry cleanly next
            // build instead of pretending the download worked.
            let _ = std::fs::remove_file(dest);
            println!("cargo:warning=embedder: curl exit {s} while fetching {url}");
        }
        Err(e) => {
            let _ = std::fs::remove_file(dest);
            println!("cargo:warning=embedder: failed to run curl for {url}: {e}");
        }
    }
}
