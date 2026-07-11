//! Background embedding task (M7 slice 2).
//!
//! Owns a long-running tokio task that periodically drains
//! the embedding backlog — every block that doesn't yet
//! have an embedding under the current model. Between
//! sweeps the task sleeps for `SWEEP_INTERVAL`, so new
//! blocks get embedded within that window of arrival.
//!
//! Eager-notification via an `mpsc` channel is a natural
//! follow-up (adds a `command_for` + `enqueue` call at the
//! PTY block-persisted callsite) but not needed for slice
//! 2's data-flow validation.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::blocks::BlockId;
use crate::search::embedding::Embedder;
use crate::store::Store;

/// How often the background task wakes up to drain the
/// backlog. Bounds worst-case indexing latency for a
/// freshly-completed block at this value.
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(30);

/// How many blocks to embed per sweep before yielding to the
/// runtime. Small enough to stay responsive under load, big
/// enough to make progress on a large history.
pub const BATCH_SIZE: usize = 32;

/// Spawn the background embedder task. Runs on the ambient
/// tokio runtime. The task takes ownership of an
/// `Arc<Store>` + `Arc<dyn Embedder>` and lives for the
/// lifetime of the app.
///
/// Errors from individual block embeds are logged but never
/// propagated — the sweep must keep making progress even
/// if one block's output turns out to be malformed.
pub fn spawn(store: Arc<Store>, embedder: Arc<dyn Embedder>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            match sweep_once(&store, embedder.as_ref()).await {
                Ok(indexed) => {
                    if indexed > 0 {
                        tracing::info!(
                            model = embedder.model_id(),
                            indexed,
                            "embedder sweep indexed {indexed} block(s)"
                        );
                    }
                }
                Err(e) => tracing::warn!("embedder sweep failed: {e:?}"),
            }
            tokio::time::sleep(SWEEP_INTERVAL).await;
        }
    })
}

/// Drain the backlog in `BATCH_SIZE` batches until it's
/// empty. Returns the number of blocks embedded during this
/// sweep so the caller can log progress.
async fn sweep_once(
    store: &Store,
    embedder: &dyn Embedder,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    let mut total = 0usize;
    loop {
        let ids = store
            .embedding_backlog(embedder.model_id(), BATCH_SIZE)
            .map_err(box_err)?;
        if ids.is_empty() {
            return Ok(total);
        }
        for id in ids {
            if let Err(e) = embed_one(store, embedder, id) {
                tracing::warn!("embedder: failed to embed block {id}: {e:?}");
            } else {
                total += 1;
            }
        }
        // Yield between batches so we don't hog the runtime.
        tokio::task::yield_now().await;
    }
}

fn embed_one(
    store: &Store,
    embedder: &dyn Embedder,
    id: BlockId,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Assemble the text to embed: command line + a bounded
    // slice of the block's output. Enough for a strong
    // semantic signal without ballooning per-block cost.
    let output = store.load_output(id).map_err(box_err)?.unwrap_or_default();
    let output_str = String::from_utf8_lossy(&output);
    let output_head: String = output_str.chars().take(2000).collect();
    let command = store.command_for(id).map_err(box_err)?.unwrap_or_default();
    let text = if command.is_empty() {
        output_head
    } else {
        format!("{command}\n\n{output_head}")
    };

    // The mock embedder is fast enough to run inline. When
    // the real ONNX-backed one lands in slice 2b, wrap this
    // in `spawn_blocking` at the call site above.
    let vector = embedder.embed(&text);

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    store
        .upsert_embedding(id, embedder.model_id(), &vector, now)
        .map_err(box_err)?;
    Ok(())
}

fn box_err<E: std::error::Error + Send + Sync + 'static>(
    e: E,
) -> Box<dyn std::error::Error + Send + Sync> {
    Box::new(e)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::embedding::HashEmbedder;

    fn make_store() -> Arc<Store> {
        Arc::new(Store::open(std::path::Path::new(":memory:")).expect("open in-memory store"))
    }

    #[test]
    fn sweep_returns_zero_when_no_blocks() {
        // Bare tokio runtime — the store methods are sync;
        // sweep_once itself is async only because of yields.
        let rt = tokio::runtime::Runtime::new().expect("build runtime");
        let store = make_store();
        let embedder = HashEmbedder::default();
        let n = rt
            .block_on(sweep_once(&store, &embedder))
            .expect("sweep succeeds");
        assert_eq!(n, 0);
    }
}
