//! ONNX-backed `Embedder` implementation (M7 slice 2b).
//!
//! Runs `sentence-transformers/all-MiniLM-L6-v2` (Xenova's
//! quantized ONNX export) via the `ort` crate. Produces
//! 384-dim L2-normalised vectors — the same dim / normalisation
//! contract the mock `HashEmbedder` shipped in slice 2a, so
//! swapping backends doesn't require a schema migration.
//!
//! Pipeline per `embed()` call:
//!   1. Tokenise text with the model's WordPiece tokeniser,
//!      truncating at 512 tokens (the model's max sequence
//!      length).
//!   2. Build `input_ids`, `attention_mask`, `token_type_ids`
//!      i64 tensors of shape `[1, seq_len]`.
//!   3. Run the ONNX session. Output tensor is
//!      `last_hidden_state` — `[1, seq_len, 384]` f32.
//!   4. Mean-pool over the sequence dimension, masking out
//!      padding tokens via `attention_mask`.
//!   5. L2-normalise. Caller can then treat cosine similarity
//!      as a dot product.
//!
//! `Session` is `Send` but not `Sync`, so we wrap it in a
//! `Mutex` — every `embed()` call briefly serialises through
//! the lock. Fine for our workload: the sweeper runs one
//! block at a time and the `semantic_search` command runs
//! one query at a time.

use std::path::Path;
use std::sync::Mutex;

use ort::inputs;
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Value;
use thiserror::Error;
use tokenizers::{Tokenizer, TruncationParams};

use crate::search::embedding::{l2_normalise, Embedder, DEFAULT_DIM};

/// Model identifier persisted alongside each vector. Bumping
/// this string invalidates every stored embedding under the
/// old id — the backfill sweep re-indexes them under the new
/// one on the next tick.
pub const MODEL_ID: &str = "all-MiniLM-L6-v2-onnx-q";

/// MiniLM's positional embedding table caps at 512 tokens.
/// Anything longer must be truncated before it hits the
/// session or the run panics.
const MAX_SEQ_LEN: usize = 512;

#[derive(Debug, Error)]
pub enum OnnxError {
    #[error("failed to load tokenizer: {0}")]
    TokenizerLoad(String),
    #[error("failed to configure tokenizer: {0}")]
    TokenizerConfig(String),
    // `ort::Error` is generic over the surrounding call
    // context (e.g. `ort::Error<SessionBuilder>`), so we
    // stringify at the boundary rather than pull the type
    // parameter through our enum.
    #[error("ONNX runtime failure: {0}")]
    Onnx(String),
    #[error("tokenizer produced no ids")]
    EmptyTokens,
    #[error("model output shape unexpected: {0:?}")]
    UnexpectedShape(Vec<i64>),
}

fn onnx_err<T>(e: ort::Error<T>) -> OnnxError {
    OnnxError::Onnx(e.to_string())
}

pub struct OnnxMiniLmEmbedder {
    session: Mutex<Session>,
    tokenizer: Tokenizer,
    dim: usize,
}

impl OnnxMiniLmEmbedder {
    /// Load the model + tokenizer from disk. Both files are
    /// fetched by `build.rs` and bundled as Tauri resources.
    pub fn load(model_path: &Path, tokenizer_path: &Path) -> Result<Self, OnnxError> {
        let mut tokenizer = Tokenizer::from_file(tokenizer_path)
            .map_err(|e| OnnxError::TokenizerLoad(e.to_string()))?;
        // The Xenova export ships without a truncation config
        // baked in, so set it explicitly to match MiniLM's max
        // sequence length. Without this, long blocks would
        // panic the ONNX session.
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: MAX_SEQ_LEN,
                ..Default::default()
            }))
            .map_err(|e| OnnxError::TokenizerConfig(e.to_string()))?;

        let session = Session::builder()
            .map_err(onnx_err)?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(onnx_err)?
            .commit_from_file(model_path)
            .map_err(onnx_err)?;

        Ok(Self {
            session: Mutex::new(session),
            tokenizer,
            dim: DEFAULT_DIM,
        })
    }
}

impl Embedder for OnnxMiniLmEmbedder {
    fn model_id(&self) -> &'static str {
        MODEL_ID
    }

    fn dim(&self) -> usize {
        self.dim
    }

    fn embed(&self, text: &str) -> Vec<f32> {
        match self.embed_inner(text) {
            Ok(v) => v,
            Err(e) => {
                // Fall back to a zero vector on failure. Storing
                // it (rather than skipping) keeps the sweep
                // making progress; a zero vector has cosine
                // similarity 0 with everything and won't
                // pollute nearest-neighbour results.
                tracing::warn!("onnx embed failed: {e:?}");
                vec![0.0; self.dim]
            }
        }
    }
}

impl OnnxMiniLmEmbedder {
    fn embed_inner(&self, text: &str) -> Result<Vec<f32>, OnnxError> {
        let encoding = self
            .tokenizer
            .encode(text, true)
            .map_err(|e| OnnxError::TokenizerLoad(e.to_string()))?;
        let ids: Vec<i64> = encoding.get_ids().iter().map(|&id| id as i64).collect();
        if ids.is_empty() {
            return Err(OnnxError::EmptyTokens);
        }
        let mask: Vec<i64> = encoding
            .get_attention_mask()
            .iter()
            .map(|&m| m as i64)
            .collect();
        let type_ids: Vec<i64> = encoding.get_type_ids().iter().map(|&t| t as i64).collect();
        let seq_len = ids.len();
        let shape = [1_usize, seq_len];

        let input_ids = Value::from_array((shape, ids)).map_err(onnx_err)?;
        let attention_mask_val = Value::from_array((shape, mask.clone())).map_err(onnx_err)?;
        let token_type_ids = Value::from_array((shape, type_ids)).map_err(onnx_err)?;

        // Extract the output tensor into an owned buffer while
        // the session lock is held — the `try_extract_tensor`
        // return value borrows from `outputs`, which borrows
        // from the session, so we can't release the lock
        // before copying.
        let (out_shape, data_owned): (Vec<i64>, Vec<f32>) = {
            let mut session = self.session.lock().expect("onnx session mutex poisoned");
            let outputs = session
                .run(inputs![
                    "input_ids" => input_ids,
                    "attention_mask" => attention_mask_val,
                    "token_type_ids" => token_type_ids,
                ])
                .map_err(onnx_err)?;
            let (shape, data) = outputs[0].try_extract_tensor::<f32>().map_err(onnx_err)?;
            (shape.to_vec(), data.to_vec())
        };

        // The first output is `last_hidden_state` — `[1, seq_len, 384]`.
        if out_shape.len() != 3 || out_shape[0] != 1 || (out_shape[2] as usize) != self.dim {
            return Err(OnnxError::UnexpectedShape(out_shape));
        }
        let out_seq = out_shape[1] as usize;
        let out_dim = out_shape[2] as usize;
        let data = data_owned.as_slice();

        // Mean-pool over the sequence dimension, weighted by
        // the attention mask so padding tokens don't dilute
        // the average.
        let mut pooled = vec![0.0_f32; out_dim];
        let mut mask_sum = 0.0_f32;
        for i in 0..out_seq {
            if mask.get(i).copied().unwrap_or(0) == 0 {
                continue;
            }
            let base = i * out_dim;
            for (j, x) in pooled.iter_mut().enumerate() {
                *x += data[base + j];
            }
            mask_sum += 1.0;
        }
        if mask_sum > 0.0 {
            for x in pooled.iter_mut() {
                *x /= mask_sum;
            }
        }
        l2_normalise(&mut pooled);
        Ok(pooled)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Returns `(model, tokenizer)` paths in the source tree,
    /// or `None` if they haven't been fetched yet (offline
    /// build or fresh clone that skipped the download). Tests
    /// gate on this so a partial clone doesn't break `cargo
    /// test`.
    fn asset_paths() -> Option<(PathBuf, PathBuf)> {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let model = manifest_dir.join("assets/all-MiniLM-L6-v2.onnx");
        let tokenizer = manifest_dir.join("assets/tokenizer.json");
        (model.exists() && tokenizer.exists()).then_some((model, tokenizer))
    }

    #[test]
    fn onnx_embedder_produces_unit_norm_vectors() {
        let Some((model, tokenizer)) = asset_paths() else {
            eprintln!("skipping: model / tokenizer not present under assets/");
            return;
        };
        let embedder = OnnxMiniLmEmbedder::load(&model, &tokenizer).expect("load");
        let v = embedder.embed("git status");
        assert_eq!(v.len(), DEFAULT_DIM);
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-4, "expected unit norm, got {norm}");
    }

    #[test]
    fn onnx_embedder_is_deterministic() {
        let Some((model, tokenizer)) = asset_paths() else {
            eprintln!("skipping: model / tokenizer not present under assets/");
            return;
        };
        let embedder = OnnxMiniLmEmbedder::load(&model, &tokenizer).expect("load");
        let a = embedder.embed("list files in directory");
        let b = embedder.embed("list files in directory");
        assert_eq!(a, b);
    }

    #[test]
    fn onnx_embedder_semantically_close_inputs_rank_close() {
        let Some((model, tokenizer)) = asset_paths() else {
            eprintln!("skipping: model / tokenizer not present under assets/");
            return;
        };
        let embedder = OnnxMiniLmEmbedder::load(&model, &tokenizer).expect("load");
        let anchor = embedder.embed("list files in this directory");
        let near = embedder.embed("show the contents of this folder");
        let far = embedder.embed("check the git commit history for a bug");
        let sim = |a: &[f32], b: &[f32]| a.iter().zip(b).map(|(x, y)| x * y).sum::<f32>();
        let near_sim = sim(&anchor, &near);
        let far_sim = sim(&anchor, &far);
        assert!(
            near_sim > far_sim,
            "expected semantic near > semantic far; got near={near_sim}, far={far_sim}"
        );
    }
}
