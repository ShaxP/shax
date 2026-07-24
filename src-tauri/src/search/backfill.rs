//! Background embedding task (M7 slice 2, eager wake-up
//! wired in M7 loose-end pass).
//!
//! Owns a long-running task that drains the embedding backlog
//! — every block that doesn't yet have an embedding under the
//! current model. It wakes on either signal:
//!
//! - An eager `mpsc::Receiver<()>` fed by the PTY reader
//!   after every newly-persisted block. Latency for a
//!   freshly-completed block drops from up to `SWEEP_INTERVAL`
//!   to whatever the tokio wake-up costs (single-digit ms in
//!   practice).
//! - A periodic `SWEEP_INTERVAL` tick, as a safety net that
//!   catches anything the eager path misses (app restarted
//!   with a backlog, sender dropped, etc.).
//!
//! Runs on `tauri::async_runtime` (Tauri's tokio wrapper).
//! We can't use `tokio::spawn` directly from the `.setup`
//! callback because that runs before the runtime is bound
//! to the current thread; Tauri's wrapper hides that
//! detail — a spawn from any thread lands on the shared
//! runtime.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::async_runtime::{self, JoinHandle};
use tokio::sync::mpsc;

use crate::blocks::BlockId;
use crate::search::embedding::Embedder;
use crate::store::Store;

/// Capacity for the eager-wake channel. Tiny — one signal is
/// enough to wake a sweep that then drains the whole backlog.
/// Bigger buffers just waste memory on a mostly-empty channel.
pub const WAKE_CHANNEL_CAPACITY: usize = 8;

/// Create the eager-wake channel used to poke the embedder
/// after every newly-persisted block. Returned in
/// `(Sender, Receiver)` order so `lib.rs` can hand the sender
/// to the PTY manager and the receiver to `spawn`.
pub fn wake_channel() -> (mpsc::Sender<()>, mpsc::Receiver<()>) {
    mpsc::channel(WAKE_CHANNEL_CAPACITY)
}

/// How often the background task wakes up to drain the
/// backlog. Bounds worst-case indexing latency for a
/// freshly-completed block at this value.
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(30);

/// How many blocks to embed per sweep before yielding to the
/// runtime. Small enough to stay responsive under load, big
/// enough to make progress on a large history.
pub const BATCH_SIZE: usize = 32;

/// Spawn the background embedder task on Tauri's async
/// runtime. The task takes ownership of an `Arc<Store>` +
/// `Arc<dyn Embedder>` and lives for the lifetime of the app.
///
/// We use `tauri::async_runtime::spawn` rather than
/// `tokio::spawn` because `.setup` fires before Tauri binds
/// the tokio runtime to the calling thread, so a bare
/// `tokio::spawn` there panics with "no reactor running".
///
/// Errors from individual block embeds are logged but never
/// propagated — the sweep must keep making progress even
/// if one block's output turns out to be malformed.
pub fn spawn(
    store: Arc<Store>,
    embedder: Arc<dyn Embedder>,
    mut wake: mpsc::Receiver<()>,
) -> JoinHandle<()> {
    async_runtime::spawn(async move {
        loop {
            match sweep_once(&store, &embedder).await {
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
            // Wait for either an eager wake from the PTY
            // reader (a new block just landed) or the safety-net
            // periodic tick. Whichever fires first, we loop back
            // to `sweep_once`, which drains the whole backlog —
            // so we deliberately don't try to drain queued wake
            // signals here; the next sweep will pick them up.
            tokio::select! {
                _ = wake.recv() => {},
                _ = tokio::time::sleep(SWEEP_INTERVAL) => {},
            }
        }
    })
}

/// Drain the backlog in `BATCH_SIZE` batches until it's
/// empty. Returns the number of blocks embedded during this
/// sweep so the caller can log progress.
async fn sweep_once(
    store: &Arc<Store>,
    embedder: &Arc<dyn Embedder>,
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
            match embed_one(store.clone(), embedder.clone(), id).await {
                Ok(()) => total += 1,
                Err(e) => tracing::warn!("embedder: failed to embed block {id}: {e:?}"),
            }
        }
        // Yield between batches so we don't hog the runtime.
        tokio::task::yield_now().await;
    }
}

async fn embed_one(
    store: Arc<Store>,
    embedder: Arc<dyn Embedder>,
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

    // Inference is CPU-heavy for the real ONNX embedder
    // (10-100 ms/block). Push it onto the blocking-thread
    // pool so we don't monopolise an async worker. The mock
    // embedder returns almost instantly but pays the same
    // pool-hop tax — negligible in absolute terms.
    let embedder_task = embedder.clone();
    let vector = tokio::task::spawn_blocking(move || embedder_task.embed(&text))
        .await
        .map_err(box_err)?;

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
        let embedder: Arc<dyn Embedder> = Arc::new(HashEmbedder::default());
        let n = rt
            .block_on(sweep_once(&store, &embedder))
            .expect("sweep succeeds");
        assert_eq!(n, 0);
    }
}
