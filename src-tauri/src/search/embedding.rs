//! Embedding plumbing for semantic block search (M7 slice 2).
//!
//! This slice ships the *plumbing* only — a swappable
//! `Embedder` trait, a `HashEmbedder` mock implementation
//! that produces deterministic pseudo-vectors from text, and
//! the vector storage / query helpers on `Store`.
//!
//! The real ONNX model (`all-MiniLM-L6-v2` via `ort`) lands
//! in slice 2b. Splitting them means the data-flow
//! infrastructure gets reviewed independently of the ML
//! integration, and the search-overlay UI slice (2c) isn't
//! blocked on model bundling / build config work.
//!
//! Design notes on the trait:
//!   - Sync `embed(&str)` — even the real ONNX runtime is
//!     synchronous per-inference; the background task that
//!     drives the embedder wraps `spawn_blocking` at the
//!     tokio boundary.
//!   - Owned `Vec<f32>` output — copy cost is negligible vs
//!     the inference cost and it simplifies lifetimes for
//!     the caller.
//!   - `model_id()` — short stable tag persisted alongside
//!     each vector so a mid-flight model swap doesn't
//!     corrupt the query path.
//!   - `dim()` — persisted per-row so vectors from
//!     different-dim models can coexist during migration.
//!
//! All vectors are L2-normalised on production output;
//! callers can then treat cosine similarity as a dot
//! product. `cosine_similarity` accepts unnormalised
//! vectors too so tests don't have to remember to
//! normalise.

use std::hash::{Hash, Hasher};

/// Default vector dimensionality — matches `all-MiniLM-L6-v2`
/// so slice 2b can drop in the real model without a schema
/// change.
pub const DEFAULT_DIM: usize = 384;

/// A pluggable embedder. Implementations live under this
/// module; the runtime picks one at store-open time (mock
/// today, ONNX-backed in slice 2b).
#[allow(dead_code)] // `dim` + `embed_batch` land in slice 2b's ONNX integration.
pub trait Embedder: Send + Sync {
    /// Short opaque tag stored alongside each vector so a
    /// backfill under a stale model is diagnosable.
    fn model_id(&self) -> &'static str;
    /// Output dimensionality. Must match the length of every
    /// vector `embed()` returns.
    fn dim(&self) -> usize;
    /// Embed a single input. Length must equal `self.dim()`.
    fn embed(&self, text: &str) -> Vec<f32>;
    /// Embed a batch. Default implementation loops over
    /// `embed`, but real backends should override with a
    /// batched forward pass for throughput.
    fn embed_batch(&self, texts: &[&str]) -> Vec<Vec<f32>> {
        texts.iter().map(|t| self.embed(t)).collect()
    }
}

/// Deterministic mock embedder. Distributes text tokens
/// across the vector dimensions via a stable hash and
/// L2-normalises the result. Useful for:
///   - unit tests that need reproducible vectors
///   - development builds before the real model lands
///   - graceful fallback when the ONNX runtime fails to load
///
/// Not semantically meaningful — two texts that share tokens
/// will end up near each other in vector space, but that's a
/// coincidence of the hash distribution, not
/// language-understanding.
pub struct HashEmbedder {
    dim: usize,
}

impl HashEmbedder {
    pub fn new(dim: usize) -> Self {
        Self { dim }
    }
}

impl Default for HashEmbedder {
    fn default() -> Self {
        Self::new(DEFAULT_DIM)
    }
}

impl Embedder for HashEmbedder {
    fn model_id(&self) -> &'static str {
        "mock-hash-v1"
    }

    fn dim(&self) -> usize {
        self.dim
    }

    fn embed(&self, text: &str) -> Vec<f32> {
        let mut v = vec![0.0f32; self.dim];
        // Split on non-alphanumeric so we approximate word
        // boundaries — good enough for a mock.
        for token in text.split(|c: char| !c.is_alphanumeric()) {
            if token.is_empty() {
                continue;
            }
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            token.to_lowercase().hash(&mut hasher);
            let h = hasher.finish();
            let idx = (h as usize) % self.dim;
            // Sign bit derived from a different bit of the
            // hash so common tokens don't all pile up
            // positive.
            let sign = if h & 0x8000_0000_0000_0000 == 0 {
                1.0
            } else {
                -1.0
            };
            v[idx] += sign;
        }
        l2_normalise(&mut v);
        v
    }
}

/// Cosine similarity between two vectors. Accepts
/// unnormalised inputs. Returns a value in `[-1.0, 1.0]`;
/// higher is more similar.
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        norm_a += a[i] * a[i];
        norm_b += b[i] * b[i];
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a.sqrt() * norm_b.sqrt())
}

/// L2-normalise a vector in place. No-op on zero vectors.
pub fn l2_normalise(v: &mut [f32]) {
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

// --- BLOB serialisation ---------------------------------------------------

/// Serialise a vector to a little-endian f32 BLOB — the same
/// layout `sqlite-vec` uses, so if we later promote the
/// `block_embeddings` table to a `vec0` virtual table the
/// on-disk bytes stay compatible.
pub fn vector_to_blob(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

/// Deserialise a f32 BLOB back into a vector. Returns `None`
/// when the length isn't a multiple of 4 or doesn't match
/// the expected dimension.
pub fn vector_from_blob(bytes: &[u8], expected_dim: usize) -> Option<Vec<f32>> {
    if bytes.len() != expected_dim * 4 {
        return None;
    }
    let mut out = Vec::with_capacity(expected_dim);
    for chunk in bytes.chunks_exact(4) {
        let arr: [u8; 4] = chunk.try_into().ok()?;
        out.push(f32::from_le_bytes(arr));
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_embedder_produces_expected_dim() {
        let e = HashEmbedder::new(64);
        let v = e.embed("hello world");
        assert_eq!(v.len(), 64);
    }

    #[test]
    fn hash_embedder_is_deterministic() {
        let e = HashEmbedder::default();
        let a = e.embed("git status");
        let b = e.embed("git status");
        assert_eq!(a, b);
    }

    #[test]
    fn hash_embedder_normalises_output() {
        let e = HashEmbedder::default();
        let v = e.embed("some text to embed");
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!(
            (norm - 1.0).abs() < 1e-5,
            "expected unit-norm vector, got norm={norm}"
        );
    }

    #[test]
    fn hash_embedder_empty_text_returns_zero_vector() {
        let e = HashEmbedder::new(16);
        let v = e.embed("");
        assert_eq!(v, vec![0.0; 16]);
    }

    #[test]
    fn cosine_similarity_identity_is_one() {
        let v = vec![1.0, 2.0, 3.0];
        assert!((cosine_similarity(&v, &v) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_similarity_orthogonal_is_zero() {
        let a = vec![1.0, 0.0];
        let b = vec![0.0, 1.0];
        assert!(cosine_similarity(&a, &b).abs() < 1e-6);
    }

    #[test]
    fn cosine_similarity_opposite_is_negative_one() {
        let a = vec![1.0, 2.0];
        let b = vec![-1.0, -2.0];
        assert!((cosine_similarity(&a, &b) + 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_similarity_length_mismatch_is_zero() {
        assert_eq!(cosine_similarity(&[1.0, 2.0], &[1.0, 2.0, 3.0]), 0.0);
    }

    #[test]
    fn blob_round_trips_a_vector() {
        let v = vec![0.1_f32, -0.2, 42.0, f32::NEG_INFINITY, 0.0];
        let bytes = vector_to_blob(&v);
        assert_eq!(bytes.len(), v.len() * 4);
        let back = vector_from_blob(&bytes, v.len()).unwrap();
        assert_eq!(back, v);
    }

    #[test]
    fn blob_with_wrong_length_returns_none() {
        let v = vec![1.0, 2.0, 3.0];
        let bytes = vector_to_blob(&v);
        assert!(vector_from_blob(&bytes, v.len() + 1).is_none());
        assert!(vector_from_blob(&bytes[..bytes.len() - 1], v.len()).is_none());
    }

    #[test]
    fn embed_batch_default_matches_individual_calls() {
        let e = HashEmbedder::default();
        let inputs = ["one", "two", "three"];
        let batch = e.embed_batch(&inputs);
        for (i, text) in inputs.iter().enumerate() {
            assert_eq!(batch[i], e.embed(text));
        }
    }

    #[test]
    fn model_id_is_stable() {
        let e = HashEmbedder::default();
        assert_eq!(e.model_id(), "mock-hash-v1");
    }
}
