//! SQLite store: schema, migrations, and per-block output persistence.
//!
//! One file, one connection guarded by a synchronous mutex. The store is
//! always written to off the reader's hot path — callers either invoke
//! `insert_block` from a tokio task or from teardown, never from inside the
//! VT processing loop.
//!
//! Per `specs/05-search-and-data-model.md` the long-term storage plan is
//! head+tail in-row + a spill file for large outputs, plus FTS5 / sqlite-vec
//! indexes. Slice 4 lands the bare table and inline-blob output; the indexes
//! and spill arrive at M3 and M4 respectively. The schema reserves room.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use thiserror::Error;

use crate::blocks::{BlockId, BlockSummary};
use crate::pty::PtyId;

/// Cap captured output written to the DB at 1 MiB per block. Matches the
/// in-memory cap in `blocks::OUTPUT_CAP_BYTES`. Larger outputs spill to disk
/// in M4 per `specs/05`.
const OUTPUT_CAP_BYTES: usize = 1024 * 1024;

/// Filter on the success / failure status of search results.
///
/// `Any` (the default) returns every block matching the query; the
/// narrower modes mirror the status iconography the frontend already
/// shows on a block row, so a user toggling "fail" gets exactly the
/// rows with a non-zero, non-aborted exit code.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchStatus {
    #[default]
    Any,
    Ok,
    Fail,
    Aborted,
}

/// Composite options for `Store::search`. Built around an FTS5 MATCH
/// query plus optional structured filters that the frontend exposes as
/// the chips above the search input. The Tauri command deserialises
/// straight into this struct, so the field set on the TS side is the
/// authoritative shape.
#[derive(Debug, Default, Clone, serde::Deserialize)]
pub struct SearchOptions {
    /// The raw FTS5 MATCH expression. Empty / invalid → no results.
    pub query: String,
    pub limit: usize,
    pub offset: usize,
    /// Narrow on the block's terminal status. `Any` skips the filter.
    #[serde(default)]
    pub status: SearchStatus,
    /// Lower bound on `started_at_ms` (inclusive). `None` skips the filter.
    #[serde(default)]
    pub since_ms: Option<u64>,
    /// Narrow on the exact `cwd` the block ran in. `None` skips the
    /// filter. Slice 3.3 only does exact-equality matching (the
    /// "Here" chip passes the active pane's cwd verbatim); free-form
    /// path / glob filtering is a deferred M3 follow-up.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Narrow on the exact git branch the block ran on. `None` skips
    /// the filter. Exact-equality match, same shape as `cwd`.
    #[serde(default)]
    pub git_branch: Option<String>,
}

/// One search result: the matching block summary plus, when available,
/// a short ANSI-marked excerpt from the indexed output ("snippet") that
/// the UI uses to show *why* the row matched. `pane_id` carries the
/// originating PTY id so the frontend can jump to a still-alive pane
/// instead of opening the read-only viewer modal.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchHit {
    pub block: BlockSummary,
    pub pane_id: PtyId,
    /// `None` when the match was on the command line only (output column
    /// is empty or the query matched in `command`). HTML-safe — the
    /// frontend escapes the surrounding text and renders `<mark>` /
    /// `</mark>` literally as marker tokens.
    pub snippet: Option<String>,
}

/// Cap how much of a block's stripped output we feed into the FTS5 index.
/// 32 KiB covers the typical "where did I see that error string" case
/// while keeping the on-disk index from ballooning — at 32 KiB per block
/// the index for 10 000 blocks stays in the low-hundreds-of-MB range.
/// Beyond this the trailing bytes are still in the `blocks.output` BLOB,
/// just not searchable; M7 introduces head+tail spill for the full bytes.
const FTS_OUTPUT_CAP_BYTES: usize = 32 * 1024;

/// Errors returned by the store. The IPC layer converts these to strings.
#[derive(Debug, Error)]
pub enum StoreError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),
}

/// Persisted record for a single completed (or aborted) block.
///
/// Mirrors `blocks::BlockSummary` plus `pane_id`, the captured `output`
/// bytes, and a future-reserved `host` slot. `argv` is reserved for later
/// argv parsing; `session_id` for M2 multiplexing.
#[derive(Debug, Clone)]
pub struct PersistedBlock {
    pub id: BlockId,
    pub pane_id: PtyId,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub started_at_ms: u64,
    pub ended_at_ms: Option<u64>,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<u64>,
    pub aborted: bool,
    /// True when the alternate screen was active at any point during this
    /// block (vim, htop, less, …). Persisted so the UI knows not to show
    /// the (garbled) output preview after a restart.
    pub interactive: bool,
    pub output: Vec<u8>,
}

/// Per-app SQLite store. `Send + Sync` via the inner mutex; clone the
/// `Arc<Store>` rather than re-opening the connection.
pub struct Store {
    conn: Mutex<Connection>,
}

// ── ANSI stripping ────────────────────────────────────────────────────────────
//
// FTS5 indexes text, not raw byte streams. Captured `output` blobs include
// CSI / OSC escape sequences from colours, cursor moves, and OSC 133 markers;
// indexing them verbatim would either pollute the index with garbage tokens or
// trip the tokenizer up. Strip them here and feed the FTS table the bare text.
//
// Mirrors the frontend's `stripAnsi` in `BlockRow.tsx` — CSI is `ESC [ … final`
// (final byte in 0x40..=0x7e); OSC is `ESC ] … (BEL | ST)`; any other `ESC`
// drops the byte that follows.

/// Strip CSI and OSC escape sequences from a captured-output byte stream,
/// returning a UTF-8 string of the surviving printable text (with byte
/// sequences that aren't valid UTF-8 replaced by U+FFFD).
fn strip_ansi(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek().copied() {
            Some('[') => {
                chars.next();
                // CSI: consume until a final byte in 0x40..=0x7e.
                while let Some(&c) = chars.peek() {
                    chars.next();
                    if matches!(c, '\u{40}'..='\u{7e}') {
                        break;
                    }
                }
            }
            Some(']') => {
                chars.next();
                // OSC: consume until BEL (0x07) or ST (ESC '\\').
                while let Some(&c) = chars.peek() {
                    chars.next();
                    if c == '\u{07}' {
                        break;
                    }
                    if c == '\u{1b}' {
                        if chars.peek().copied() == Some('\\') {
                            chars.next();
                        }
                        break;
                    }
                }
            }
            Some(_) => {
                // Two-byte ESC sequence (charset selects, save/restore cursor,
                // …): drop ESC + the next byte.
                chars.next();
            }
            None => {}
        }
    }
    out
}

/// Slice the raw output bytes down to at most `FTS_OUTPUT_CAP_BYTES`,
/// returning the ANSI-stripped UTF-8 prefix that goes into the index.
fn prepare_fts_output(bytes: &[u8]) -> String {
    let cap = FTS_OUTPUT_CAP_BYTES.min(bytes.len());
    strip_ansi(&bytes[..cap])
}

/// Backfill `blocks_fts` from rows in `blocks` that aren't yet indexed.
/// Idempotent: subsequent opens skip blocks already present in the FTS
/// table. Streams one row at a time so the worst-case memory footprint is
/// bounded by one block's capped output, not the whole history.
fn backfill_fts(conn: &Connection) -> Result<(), StoreError> {
    let ids: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT id FROM blocks
             WHERE id NOT IN (SELECT block_id FROM blocks_fts)",
        )?;
        let collected: Vec<String> = stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        collected
    };
    if ids.is_empty() {
        return Ok(());
    }
    tracing::info!(count = ids.len(), "backfilling blocks_fts from blocks");
    let tx = conn.unchecked_transaction()?;
    for id in ids {
        let (command, output_bytes, interactive_int): (Option<String>, Option<Vec<u8>>, i32) = tx
            .query_row(
            "SELECT command, output, interactive FROM blocks WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        // Same exclusion as `insert_block`: alt-screen output is cursor
        // / grid manipulation, not flow text. Skip indexing it; the
        // command line stays searchable so "vim foo.txt" still finds
        // the block.
        let output_text = if interactive_int != 0 {
            String::new()
        } else {
            output_bytes
                .map(|b| prepare_fts_output(&b))
                .unwrap_or_default()
        };
        tx.execute(
            "INSERT INTO blocks_fts (block_id, command, output)
             VALUES (?1, ?2, ?3)",
            params![id, command, output_text],
        )?;
    }
    tx.commit()?;
    Ok(())
}

impl Store {
    /// Open or create the database at `path`, applying the schema if needed.
    /// Intermediate directories are created.
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        Self::init(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Open an in-memory store, used by tests. Not exposed to production
    /// callers — `lib.rs` always opens against the user's data dir so a
    /// crash doesn't silently drop history.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory()?;
        Self::init(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn init(conn: &Connection) -> Result<(), StoreError> {
        // Schema is versioned via `PRAGMA user_version`. v1 was the initial
        // blocks-only schema; v2 added the per-block `interactive` flag and
        // the `app_state` table; v3 adds the FTS5 search index over command
        // text and stripped output. Older databases migrate forward on open
        // via the matching branches below.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

        if version < 2 {
            conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS blocks (
                    id            TEXT PRIMARY KEY,        -- UUID
                    pane_id       TEXT NOT NULL,           -- UUID
                    session_id    TEXT,                    -- reserved for M2
                    command       TEXT,                    -- typed line, may be NULL
                    argv          TEXT,                    -- reserved JSON array
                    cwd           TEXT,
                    git_branch    TEXT,
                    host          TEXT,                    -- reserved (local vs ssh)
                    exit_code     INTEGER,
                    started_at_ms INTEGER NOT NULL,
                    ended_at_ms   INTEGER,
                    duration_ms   INTEGER,
                    aborted       INTEGER NOT NULL DEFAULT 0,
                    output        BLOB
                );
                CREATE INDEX IF NOT EXISTS idx_blocks_started_at
                    ON blocks(started_at_ms);
                CREATE INDEX IF NOT EXISTS idx_blocks_pane_started
                    ON blocks(pane_id, started_at_ms);
                CREATE TABLE IF NOT EXISTS app_state (
                    id            INTEGER PRIMARY KEY CHECK (id = 1),
                    tabs_json     TEXT NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                );
                "#,
            )?;
        }

        if version == 1 {
            // Upgrading a v1 database: the blocks table exists but lacks
            // the `interactive` column. ADD COLUMN with a default keeps
            // historical rows valid (they predate alt-screen tracking;
            // false is the right neutral fallback for vim/htop blocks
            // captured before this slice).
            conn.execute_batch(
                r#"
                ALTER TABLE blocks
                    ADD COLUMN interactive INTEGER NOT NULL DEFAULT 0;
                "#,
            )?;
        } else if version < 1 {
            // Fresh v0 → ensure the column is present on the brand-new
            // blocks table by re-running the ALTER ourselves; SQLite has
            // no `IF NOT EXISTS` for columns, so we add it conditionally
            // by checking for it first.
            let has_interactive: bool = conn.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('blocks') WHERE name = 'interactive'",
                [],
                |row| row.get::<_, i64>(0).map(|n| n > 0),
            )?;
            if !has_interactive {
                conn.execute_batch(
                    "ALTER TABLE blocks ADD COLUMN interactive INTEGER NOT NULL DEFAULT 0;",
                )?;
            }
        }

        // v3: full-text search index. The FTS5 table mirrors the indexable
        // columns of `blocks` (the typed command line plus an ANSI-stripped
        // prefix of the captured output). `UNINDEXED` on `block_id` means
        // we can JOIN back to `blocks` to fetch the summary fields without
        // duplicating storage for the metadata.
        if version < 3 {
            conn.execute_batch(
                r#"
                CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
                    block_id UNINDEXED,
                    command,
                    output,
                    tokenize = 'porter unicode61 remove_diacritics 2'
                );
                "#,
            )?;
            // Backfill rows that existed before this version. Idempotent —
            // skips ids already present so repeated opens don't double-index.
            backfill_fts(conn)?;
        }

        conn.pragma_update(None, "user_version", 3)?;

        // One-shot dedup: an earlier build of the FTS-insert path didn't
        // delete prior rows before inserting, so re-running `insert_block`
        // for the same block id (which the writer does as the block's
        // metadata fills in) left duplicate rows behind. They surface as
        // "5 results, 1 visible row" because the search overlay keys by
        // block id and React renders only one. Keep the lowest-rowid row
        // per block_id and drop the rest. Runs every open, cheap when
        // there's nothing to clean (DELETE … WHERE rowid IN (empty)).
        let dropped = conn.execute(
            r#"
            DELETE FROM blocks_fts
            WHERE rowid NOT IN (
                SELECT MIN(rowid) FROM blocks_fts GROUP BY block_id
            )
            "#,
            [],
        )?;
        if dropped > 0 {
            tracing::info!(dropped, "removed duplicate rows from blocks_fts");
        }

        Ok(())
    }

    /// Persist (or replace) one block. Idempotent on `id`.
    ///
    /// The output bytes are truncated at `OUTPUT_CAP_BYTES`.
    pub fn insert_block(&self, block: &PersistedBlock) -> Result<(), StoreError> {
        let truncated = if block.output.len() > OUTPUT_CAP_BYTES {
            &block.output[..OUTPUT_CAP_BYTES]
        } else {
            &block.output[..]
        };
        let conn = self.conn.lock().expect("store mutex poisoned");
        let id_str = block.id.to_string();
        // Interactive sessions (vim, htop, less, …) emit cursor / grid
        // bytes, not flow text — indexing the stripped output gives
        // search a haystack of fragments that match the user's queries
        // by accident ("nodes" hits from a status line, etc.). Skip the
        // output column for these; the command line still indexes so
        // "vim foo.txt" remains findable.
        let fts_output = if block.interactive {
            String::new()
        } else {
            prepare_fts_output(truncated)
        };
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            r#"
            INSERT INTO blocks
                (id, pane_id, command, cwd, git_branch,
                 exit_code, started_at_ms, ended_at_ms, duration_ms,
                 aborted, interactive, output)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            ON CONFLICT(id) DO UPDATE SET
                command       = excluded.command,
                cwd           = excluded.cwd,
                git_branch    = excluded.git_branch,
                exit_code     = excluded.exit_code,
                ended_at_ms   = excluded.ended_at_ms,
                duration_ms   = excluded.duration_ms,
                aborted       = excluded.aborted,
                interactive   = excluded.interactive,
                output        = excluded.output
            "#,
            params![
                id_str,
                block.pane_id.to_string(),
                block.command,
                block.cwd,
                block.git_branch,
                block.exit_code,
                block.started_at_ms as i64,
                block.ended_at_ms.map(|v| v as i64),
                block.duration_ms.map(|v| v as i64),
                i32::from(block.aborted),
                i32::from(block.interactive),
                truncated,
            ],
        )?;
        // Keep the FTS index in lockstep with the row. Upserting a block
        // re-indexes it (e.g. when streaming completes and the output
        // bytes are finalised); we delete the prior FTS row, then insert.
        tx.execute(
            "DELETE FROM blocks_fts WHERE block_id = ?1",
            params![id_str],
        )?;
        tx.execute(
            "INSERT INTO blocks_fts (block_id, command, output)
             VALUES (?1, ?2, ?3)",
            params![id_str, block.command, fts_output],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Run a full-text search across `blocks_fts` and return matching
    /// hits, ranked by FTS5 BM25. `opts.query` is the raw FTS5 MATCH
    /// expression — whitespace-separated words are AND'd implicitly.
    /// Status and time filters compose with the FTS match. An empty /
    /// whitespace-only query, or syntactically-invalid FTS5 input,
    /// short-circuits to an empty result so the search bar can read
    /// "no matches" while the user finishes typing.
    ///
    /// Each hit carries the `pane_id` of the originating PTY (so the
    /// frontend can jump back to a still-alive pane) and, when the
    /// match landed in `output`, a `snippet()` excerpt with
    /// `<mark>…</mark>` around the matching tokens.
    pub fn search(&self, opts: &SearchOptions) -> Result<Vec<SearchHit>, StoreError> {
        let trimmed = opts.query.trim();
        let has_filter = opts.status != SearchStatus::Any
            || opts.since_ms.is_some()
            || opts.cwd.is_some()
            || opts.git_branch.is_some();
        if trimmed.is_empty() && !has_filter {
            // Empty query and no active filter → nothing to show. Keeps
            // the search overlay's initial state clean instead of
            // dumping the entire history the moment ⌘K opens.
            return Ok(Vec::new());
        }
        if trimmed.is_empty() {
            // Filter-only browse mode: dodge FTS5 entirely and read
            // straight from `blocks`, ordered most-recent first. Hits
            // carry no snippet (nothing to highlight).
            return self.search_by_filter(opts);
        }

        // Compose optional filter SQL inline; each branch widens both
        // the SQL and the named-bind list. Named binds keep the query
        // readable as the filter set grows in slice 3.3+ (cwd, branch).
        let mut clauses: Vec<&'static str> = Vec::new();
        match opts.status {
            SearchStatus::Any => {}
            SearchStatus::Ok => clauses.push("b.aborted = 0 AND b.exit_code = 0"),
            SearchStatus::Fail => clauses.push("b.aborted = 0 AND b.exit_code != 0"),
            SearchStatus::Aborted => clauses.push("b.aborted = 1"),
        }
        if opts.since_ms.is_some() {
            clauses.push("b.started_at_ms >= :since");
        }
        if opts.cwd.is_some() {
            clauses.push("b.cwd = :cwd");
        }
        if opts.git_branch.is_some() {
            clauses.push("b.git_branch = :branch");
        }

        let mut sql = String::from(
            r#"
            SELECT b.id, b.pane_id, b.command, b.cwd, b.git_branch,
                   b.started_at_ms, b.ended_at_ms, b.exit_code,
                   b.duration_ms, b.aborted, b.interactive,
                   snippet(blocks_fts, 2, '<mark>', '</mark>', '…', 12) AS snippet
            FROM blocks_fts
            JOIN blocks b ON b.id = blocks_fts.block_id
            WHERE blocks_fts MATCH :match
            "#,
        );
        for clause in &clauses {
            sql.push_str(" AND ");
            sql.push_str(clause);
        }
        // Chronological, newest first. For a shell-history search the
        // user almost always wants the most recent matching block,
        // and this stays consistent with the browse-by-filter path
        // (empty query + active filter, see `search_by_filter`)
        // which also orders by `started_at_ms DESC`. FTS rank values
        // on short shell commands are noisy and rarely useful.
        sql.push_str(" ORDER BY b.started_at_ms DESC LIMIT :limit OFFSET :offset");

        let conn = self.conn.lock().expect("store mutex poisoned");
        let attempt = (|| -> Result<Vec<SearchHit>, rusqlite::Error> {
            let limit_i64 = opts.limit as i64;
            let offset_i64 = opts.offset as i64;
            let since_i64 = opts.since_ms.map(|v| v as i64);
            let mut bind: Vec<(&str, &dyn rusqlite::ToSql)> = vec![
                (":match", &trimmed),
                (":limit", &limit_i64),
                (":offset", &offset_i64),
            ];
            if let Some(ref s) = since_i64 {
                bind.push((":since", s));
            }
            if let Some(ref cwd) = opts.cwd {
                bind.push((":cwd", cwd));
            }
            if let Some(ref branch) = opts.git_branch {
                bind.push((":branch", branch));
            }
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(bind.as_slice(), |row| {
                let id_str: String = row.get(0)?;
                let id = BlockId::parse(&id_str).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
                    )
                })?;
                let pane_id_str: String = row.get(1)?;
                let pane_uuid = uuid::Uuid::parse_str(&pane_id_str).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        1,
                        rusqlite::types::Type::Text,
                        Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
                    )
                })?;
                let pane_id = PtyId(pane_uuid);
                let started_at_ms: i64 = row.get(5)?;
                let ended_at_ms: Option<i64> = row.get(6)?;
                let exit_code: Option<i32> = row.get(7)?;
                let duration_ms: Option<i64> = row.get(8)?;
                let aborted_int: i32 = row.get(9)?;
                let interactive_int: i32 = row.get(10)?;
                let snippet: Option<String> = row.get(11)?;
                Ok(SearchHit {
                    block: BlockSummary {
                        id,
                        command: row.get(2)?,
                        cwd: row.get(3)?,
                        git_branch: row.get(4)?,
                        started_at_ms: started_at_ms as u64,
                        ended_at_ms: ended_at_ms.map(|v| v as u64),
                        exit_code,
                        duration_ms: duration_ms.map(|v| v as u64),
                        aborted: aborted_int != 0,
                        interactive: interactive_int != 0,
                    },
                    pane_id,
                    snippet: snippet.filter(|s| !s.is_empty()),
                })
            })?;
            rows.collect::<Result<_, _>>()
        })();
        match attempt {
            Ok(v) => Ok(v),
            Err(e) => {
                tracing::debug!("search query rejected by FTS5: {e}");
                Ok(Vec::new())
            }
        }
    }

    /// Load the persisted app-state JSON blob (tabs + layout + focus),
    /// or `None` if nothing has been saved yet.
    pub fn load_app_state(&self) -> Result<Option<String>, StoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let json = conn
            .query_row("SELECT tabs_json FROM app_state WHERE id = 1", [], |row| {
                row.get::<_, String>(0)
            })
            .optional()?;
        Ok(json)
    }

    /// Upsert the single app-state row with the given JSON blob.
    pub fn save_app_state(&self, json: &str, now_ms: u64) -> Result<(), StoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        conn.execute(
            r#"
            INSERT INTO app_state (id, tabs_json, updated_at_ms)
            VALUES (1, ?1, ?2)
            ON CONFLICT(id) DO UPDATE SET
                tabs_json     = excluded.tabs_json,
                updated_at_ms = excluded.updated_at_ms
            "#,
            params![json, now_ms as i64],
        )?;
        Ok(())
    }

    /// Filter-only browse: empty FTS query, but the status / since filters
    /// are active. Read straight from `blocks`, apply the filters, order
    /// most-recent first. Hits carry no snippet because there's no FTS
    /// match to anchor one on.
    fn search_by_filter(&self, opts: &SearchOptions) -> Result<Vec<SearchHit>, StoreError> {
        let mut clauses: Vec<&'static str> = Vec::new();
        match opts.status {
            SearchStatus::Any => {}
            SearchStatus::Ok => clauses.push("aborted = 0 AND exit_code = 0"),
            SearchStatus::Fail => clauses.push("aborted = 0 AND exit_code != 0"),
            SearchStatus::Aborted => clauses.push("aborted = 1"),
        }
        if opts.since_ms.is_some() {
            clauses.push("started_at_ms >= :since");
        }
        if opts.cwd.is_some() {
            clauses.push("cwd = :cwd");
        }
        if opts.git_branch.is_some() {
            clauses.push("git_branch = :branch");
        }

        let mut sql = String::from(
            r#"
            SELECT id, pane_id, command, cwd, git_branch,
                   started_at_ms, ended_at_ms, exit_code,
                   duration_ms, aborted, interactive
            FROM blocks
            WHERE 1 = 1
            "#,
        );
        for clause in &clauses {
            sql.push_str(" AND ");
            sql.push_str(clause);
        }
        sql.push_str(" ORDER BY started_at_ms DESC LIMIT :limit OFFSET :offset");

        let conn = self.conn.lock().expect("store mutex poisoned");
        let limit_i64 = opts.limit as i64;
        let offset_i64 = opts.offset as i64;
        let since_i64 = opts.since_ms.map(|v| v as i64);
        let mut bind: Vec<(&str, &dyn rusqlite::ToSql)> =
            vec![(":limit", &limit_i64), (":offset", &offset_i64)];
        if let Some(ref s) = since_i64 {
            bind.push((":since", s));
        }
        if let Some(ref cwd) = opts.cwd {
            bind.push((":cwd", cwd));
        }
        if let Some(ref branch) = opts.git_branch {
            bind.push((":branch", branch));
        }
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(bind.as_slice(), |row| {
            let id_str: String = row.get(0)?;
            let id = BlockId::parse(&id_str).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
                )
            })?;
            let pane_id_str: String = row.get(1)?;
            let pane_uuid = uuid::Uuid::parse_str(&pane_id_str).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    1,
                    rusqlite::types::Type::Text,
                    Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
                )
            })?;
            let pane_id = PtyId(pane_uuid);
            let started_at_ms: i64 = row.get(5)?;
            let ended_at_ms: Option<i64> = row.get(6)?;
            let exit_code: Option<i32> = row.get(7)?;
            let duration_ms: Option<i64> = row.get(8)?;
            let aborted_int: i32 = row.get(9)?;
            let interactive_int: i32 = row.get(10)?;
            Ok(SearchHit {
                block: BlockSummary {
                    id,
                    command: row.get(2)?,
                    cwd: row.get(3)?,
                    git_branch: row.get(4)?,
                    started_at_ms: started_at_ms as u64,
                    ended_at_ms: ended_at_ms.map(|v| v as u64),
                    exit_code,
                    duration_ms: duration_ms.map(|v| v as u64),
                    aborted: aborted_int != 0,
                    interactive: interactive_int != 0,
                },
                pane_id,
                snippet: None,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Return the most recent `limit` blocks across all panes, oldest-first
    /// Distinct non-empty `git_branch` values across the *result set* of
    /// the given search options, ordered most-recently-used first. This
    /// is the faceted-search version of `distinct_branches`: applies the
    /// same query / cwd / status / since filters as `search`, but
    /// deliberately *ignores* `opts.git_branch`. Excluding the branch
    /// filter is the standard facet rule — otherwise picking a branch
    /// would immediately collapse the dropdown to just that one option,
    /// trapping the user.
    ///
    /// Empty query + no non-branch filter degenerates to "every branch
    /// in history", matching the legacy `distinct_branches()` shape.
    pub fn distinct_branches_for(&self, opts: &SearchOptions) -> Result<Vec<String>, StoreError> {
        let trimmed = opts.query.trim();
        let mut clauses: Vec<&'static str> = Vec::new();
        match opts.status {
            SearchStatus::Any => {}
            SearchStatus::Ok => clauses.push("b.aborted = 0 AND b.exit_code = 0"),
            SearchStatus::Fail => clauses.push("b.aborted = 0 AND b.exit_code != 0"),
            SearchStatus::Aborted => clauses.push("b.aborted = 1"),
        }
        if opts.since_ms.is_some() {
            clauses.push("b.started_at_ms >= :since");
        }
        if opts.cwd.is_some() {
            clauses.push("b.cwd = :cwd");
        }
        // `opts.git_branch` is intentionally ignored — see doc comment.

        let mut sql = if trimmed.is_empty() {
            String::from(
                r#"
                SELECT b.git_branch
                  FROM blocks b
                 WHERE b.git_branch IS NOT NULL
                   AND b.git_branch <> ''
                "#,
            )
        } else {
            String::from(
                r#"
                SELECT b.git_branch
                  FROM blocks_fts
                  JOIN blocks b ON b.id = blocks_fts.block_id
                 WHERE blocks_fts MATCH :match
                   AND b.git_branch IS NOT NULL
                   AND b.git_branch <> ''
                "#,
            )
        };
        for clause in &clauses {
            sql.push_str(" AND ");
            sql.push_str(clause);
        }
        sql.push_str(" GROUP BY b.git_branch ORDER BY MAX(b.started_at_ms) DESC");

        let conn = self.conn.lock().expect("store mutex poisoned");
        let attempt = (|| -> Result<Vec<String>, rusqlite::Error> {
            let since_i64 = opts.since_ms.map(|v| v as i64);
            let mut bind: Vec<(&str, &dyn rusqlite::ToSql)> = Vec::new();
            if !trimmed.is_empty() {
                bind.push((":match", &trimmed));
            }
            if let Some(ref s) = since_i64 {
                bind.push((":since", s));
            }
            if let Some(ref cwd) = opts.cwd {
                bind.push((":cwd", cwd));
            }
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(bind.as_slice(), |row| row.get::<_, String>(0))?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            Ok(out)
        })();
        // Same swallow-on-FTS-syntax-error stance as `search`: a typed
        // partial query shouldn't surface as a "search error" toast.
        match attempt {
            Ok(v) => Ok(v),
            Err(rusqlite::Error::SqliteFailure(_, Some(msg))) if msg.contains("syntax error") => {
                Ok(Vec::new())
            }
            Err(e) => Err(e.into()),
        }
    }

    /// within the window (so the UI's chronological append order is preserved
    /// when seeding the BlockList on app boot).
    pub fn load_recent(&self, limit: usize) -> Result<Vec<BlockSummary>, StoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let mut stmt = conn.prepare(
            r#"
            SELECT id, command, cwd, git_branch,
                   started_at_ms, ended_at_ms, exit_code, duration_ms,
                   aborted, interactive
              FROM blocks
             ORDER BY started_at_ms DESC
             LIMIT ?1
            "#,
        )?;
        let rows = stmt.query_map(params![limit as i64], |row| {
            let id_str: String = row.get(0)?;
            let id = BlockId::parse(&id_str).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
                )
            })?;
            let started_at_ms: i64 = row.get(4)?;
            let ended_at_ms: Option<i64> = row.get(5)?;
            let exit_code: Option<i32> = row.get(6)?;
            let duration_ms: Option<i64> = row.get(7)?;
            let aborted_int: i32 = row.get(8)?;
            let interactive_int: i32 = row.get(9)?;
            Ok(BlockSummary {
                id,
                command: row.get(1)?,
                cwd: row.get(2)?,
                git_branch: row.get(3)?,
                started_at_ms: started_at_ms as u64,
                ended_at_ms: ended_at_ms.map(|v| v as u64),
                exit_code,
                duration_ms: duration_ms.map(|v| v as u64),
                aborted: aborted_int != 0,
                interactive: interactive_int != 0,
            })
        })?;
        let mut out: Vec<BlockSummary> = rows.collect::<Result<_, _>>()?;
        // Database order is DESC for the LIMIT; flip so UI sees oldest first.
        out.reverse();
        Ok(out)
    }

    /// Return the captured output bytes for one block, or `None` if the id
    /// is unknown.
    pub fn load_output(&self, id: BlockId) -> Result<Option<Vec<u8>>, StoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let bytes = conn
            .query_row(
                "SELECT output FROM blocks WHERE id = ?1",
                params![id.to_string()],
                |row| row.get::<_, Option<Vec<u8>>>(0),
            )
            .optional()?
            .flatten();
        Ok(bytes)
    }
}

/// Resolve the on-disk path for the Shax database under the user's app data
/// directory. Falls back to a relative path when the OS data dir is
/// unavailable (rare; only on minimal sandboxes).
pub fn default_db_path() -> PathBuf {
    if let Some(dir) = data_dir() {
        return dir.join("shax").join("shax.db");
    }
    PathBuf::from("shax.db")
}

/// Best-effort cross-platform data dir without pulling in the `dirs` crate.
fn data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            return Some(PathBuf::from(xdg));
        }
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share"))
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(PathBuf::from)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        None
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn make_block(
        pane_id: PtyId,
        started_at_ms: u64,
        command: &str,
        output: &[u8],
    ) -> PersistedBlock {
        make_block_with(pane_id, started_at_ms, command, output, "/tmp", "main")
    }

    fn make_block_with(
        pane_id: PtyId,
        started_at_ms: u64,
        command: &str,
        output: &[u8],
        cwd: &str,
        git_branch: &str,
    ) -> PersistedBlock {
        PersistedBlock {
            id: BlockId(Uuid::new_v4()),
            pane_id,
            command: Some(command.to_owned()),
            cwd: Some(cwd.to_owned()),
            git_branch: Some(git_branch.to_owned()),
            started_at_ms,
            ended_at_ms: Some(started_at_ms + 100),
            exit_code: Some(0),
            duration_ms: Some(100),
            aborted: false,
            interactive: false,
            output: output.to_vec(),
        }
    }

    #[test]
    fn schema_initialises_on_open() {
        let store = Store::open_in_memory().expect("open");
        // Inserting straight after open proves the table exists.
        let block = make_block(PtyId::new(), 1000, "ls", b"a.txt b.txt");
        store.insert_block(&block).expect("insert");
        let loaded = store.load_recent(10).expect("load");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].command.as_deref(), Some("ls"));
    }

    #[test]
    fn load_recent_returns_oldest_first_within_window() {
        let store = Store::open_in_memory().unwrap();
        let pane = PtyId::new();
        for (i, cmd) in ["one", "two", "three"].iter().enumerate() {
            store
                .insert_block(&make_block(pane, 1000 + i as u64, cmd, cmd.as_bytes()))
                .unwrap();
        }
        let loaded = store.load_recent(10).unwrap();
        let cmds: Vec<_> = loaded
            .iter()
            .map(|b| b.command.clone().unwrap_or_default())
            .collect();
        assert_eq!(cmds, vec!["one", "two", "three"]);
    }

    #[test]
    fn load_recent_respects_limit_and_returns_most_recent() {
        let store = Store::open_in_memory().unwrap();
        let pane = PtyId::new();
        for i in 0..5 {
            store
                .insert_block(&make_block(pane, 1000 + i, &format!("c{i}"), b""))
                .unwrap();
        }
        let loaded = store.load_recent(3).unwrap();
        let cmds: Vec<_> = loaded
            .iter()
            .map(|b| b.command.clone().unwrap_or_default())
            .collect();
        // Most recent three, oldest-first inside the window: c2, c3, c4.
        assert_eq!(cmds, vec!["c2", "c3", "c4"]);
    }

    #[test]
    fn insert_is_idempotent_on_id() {
        let store = Store::open_in_memory().unwrap();
        let mut block = make_block(PtyId::new(), 1000, "first", b"old");
        store.insert_block(&block).unwrap();
        block.command = Some("second".into());
        block.output = b"new".to_vec();
        store.insert_block(&block).unwrap();
        let loaded = store.load_recent(10).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].command.as_deref(), Some("second"));
        let out = store.load_output(block.id).unwrap();
        assert_eq!(out.as_deref(), Some(&b"new"[..]));
    }

    #[test]
    fn load_output_returns_none_for_unknown_id() {
        let store = Store::open_in_memory().unwrap();
        let id = BlockId(Uuid::new_v4());
        assert_eq!(store.load_output(id).unwrap(), None);
    }

    #[test]
    fn output_above_cap_is_truncated() {
        let store = Store::open_in_memory().unwrap();
        let big = vec![b'x'; OUTPUT_CAP_BYTES + 4096];
        let block = make_block(PtyId::new(), 1000, "cat big", &big);
        store.insert_block(&block).unwrap();
        let out = store.load_output(block.id).unwrap().unwrap();
        assert_eq!(out.len(), OUTPUT_CAP_BYTES);
    }

    #[test]
    fn aborted_flag_round_trips() {
        let store = Store::open_in_memory().unwrap();
        let mut block = make_block(PtyId::new(), 1000, "killed", b"partial");
        block.aborted = true;
        block.exit_code = Some(-1);
        store.insert_block(&block).unwrap();
        let loaded = store.load_recent(10).unwrap();
        assert!(loaded[0].aborted);
        assert_eq!(loaded[0].exit_code, Some(-1));
    }

    #[test]
    fn persists_across_reopen() {
        let tmpdir = tempfile::tempdir().unwrap();
        let path = tmpdir.path().join("nested").join("shax.db");
        {
            let store = Store::open(&path).expect("open first time");
            store
                .insert_block(&make_block(PtyId::new(), 1000, "first run", b"hello"))
                .unwrap();
        }
        let store = Store::open(&path).expect("open second time");
        let loaded = store.load_recent(10).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].command.as_deref(), Some("first run"));
    }

    #[test]
    fn interactive_flag_round_trips() {
        let store = Store::open_in_memory().unwrap();
        let mut block = make_block(PtyId::new(), 1000, "vim foo", b"\x1b[?1049h");
        block.interactive = true;
        store.insert_block(&block).unwrap();
        let loaded = store.load_recent(10).unwrap();
        assert!(
            loaded[0].interactive,
            "interactive flag should survive a load"
        );
    }

    #[test]
    fn app_state_round_trips() {
        let store = Store::open_in_memory().unwrap();
        assert!(store.load_app_state().unwrap().is_none());
        store.save_app_state(r#"{"tabs":[]}"#, 1234).unwrap();
        assert_eq!(
            store.load_app_state().unwrap().as_deref(),
            Some(r#"{"tabs":[]}"#),
        );
        // Upsert behaviour: second save replaces the row, doesn't insert.
        store
            .save_app_state(r#"{"tabs":[{"id":"a"}]}"#, 2000)
            .unwrap();
        assert_eq!(
            store.load_app_state().unwrap().as_deref(),
            Some(r#"{"tabs":[{"id":"a"}]}"#),
        );
    }

    #[test]
    fn app_state_persists_across_reopen() {
        let tmpdir = tempfile::tempdir().unwrap();
        let path = tmpdir.path().join("shax.db");
        {
            let store = Store::open(&path).unwrap();
            store.save_app_state(r#"{"tabs":[{"id":"x"}]}"#, 1).unwrap();
        }
        let store = Store::open(&path).unwrap();
        assert_eq!(
            store.load_app_state().unwrap().as_deref(),
            Some(r#"{"tabs":[{"id":"x"}]}"#),
        );
    }

    #[test]
    fn strip_ansi_drops_csi_osc_and_two_byte_sequences() {
        assert_eq!(strip_ansi(b"\x1b[31mhello\x1b[0m world"), "hello world");
        assert_eq!(strip_ansi(b"\x1b]0;title\x07after"), "after");
        // OSC terminated by ST (ESC \\).
        assert_eq!(strip_ansi(b"\x1b]133;A\x1b\\hi"), "hi");
        // Two-byte ESC sequence (charset select).
        assert_eq!(strip_ansi(b"\x1bMplain"), "plain");
        assert_eq!(strip_ansi(b"plain text"), "plain text");
    }

    #[test]
    fn search_finds_blocks_by_command_text() {
        let store = Store::open_in_memory().unwrap();
        let pane = PtyId::new();
        store
            .insert_block(&make_block(pane, 1000, "kubectl get pods", b""))
            .unwrap();
        store
            .insert_block(&make_block(pane, 2000, "echo hello", b""))
            .unwrap();
        let hits = store
            .search(&SearchOptions {
                query: "kubectl".into(),
                limit: 10,
                offset: 0,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block.command.as_deref(), Some("kubectl get pods"));
    }

    #[test]
    fn search_finds_blocks_by_output_text() {
        // "Where did I see that error string" — the canonical search use
        // case. The unicode61 tokenizer breaks tokens on punctuation, so
        // "Cargo.toml" indexes as two tokens; we query with bare words.
        let store = Store::open_in_memory().unwrap();
        let pane = PtyId::new();
        store
            .insert_block(&make_block(
                pane,
                1000,
                "ls",
                b"Cargo.toml src tests target\n",
            ))
            .unwrap();
        store
            .insert_block(&make_block(pane, 2000, "cat README", b"# shax\n"))
            .unwrap();
        let hits = store
            .search(&SearchOptions {
                query: "Cargo toml".into(),
                limit: 10,
                offset: 0,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block.command.as_deref(), Some("ls"));
    }

    #[test]
    fn search_ranks_command_match_above_unrelated_blocks() {
        // Implicit AND: "kubectl pods" should require both words.
        let store = Store::open_in_memory().unwrap();
        let pane = PtyId::new();
        store
            .insert_block(&make_block(pane, 1000, "kubectl get pods", b""))
            .unwrap();
        store
            .insert_block(&make_block(pane, 2000, "kubectl get nodes", b""))
            .unwrap();
        store
            .insert_block(&make_block(pane, 3000, "echo hi", b""))
            .unwrap();
        let hits = store
            .search(&SearchOptions {
                query: "kubectl pods".into(),
                limit: 10,
                offset: 0,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block.command.as_deref(), Some("kubectl get pods"));
    }

    #[test]
    fn search_strips_ansi_from_indexed_output() {
        let store = Store::open_in_memory().unwrap();
        let pane = PtyId::new();
        // The "magic" token is bracketed by SGR escapes — the index must
        // see "magic" as a bare token, not "[1mmagic[0m".
        store
            .insert_block(&make_block(
                pane,
                1000,
                "echo styled",
                b"\x1b[1mmagic\x1b[0m\n",
            ))
            .unwrap();
        let hits = store
            .search(&SearchOptions {
                query: "magic".into(),
                limit: 10,
                offset: 0,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn search_returns_empty_on_empty_or_whitespace_query() {
        let store = Store::open_in_memory().unwrap();
        let pane = PtyId::new();
        store
            .insert_block(&make_block(pane, 1000, "echo hi", b""))
            .unwrap();
        assert!(store
            .search(&SearchOptions {
                query: "".into(),
                limit: 10,
                offset: 0,
                ..Default::default()
            })
            .unwrap()
            .is_empty());
        assert!(store
            .search(&SearchOptions {
                query: "   ".into(),
                limit: 10,
                offset: 0,
                ..Default::default()
            })
            .unwrap()
            .is_empty());
    }

    #[test]
    fn search_returns_empty_on_invalid_fts5_syntax_instead_of_erroring() {
        let store = Store::open_in_memory().unwrap();
        let pane = PtyId::new();
        store
            .insert_block(&make_block(pane, 1000, "echo hi", b""))
            .unwrap();
        // Half-typed phrase / dangling operator: shouldn't error, just no
        // results, so the search overlay can stay calm while the user
        // finishes typing.
        let hits = store
            .search(&SearchOptions {
                query: "\"unterminated".into(),
                limit: 10,
                offset: 0,
                ..Default::default()
            })
            .unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn search_does_not_index_alt_screen_output() {
        // vim / htop / less emit cursor-and-grid bytes, not flow text;
        // indexing them gives the user false-positive hits ("nodes" in a
        // htop status line matching a `kubectl get nodes` query). The
        // command line itself still indexes so `vim foo.txt` is findable.
        let store = Store::open_in_memory().unwrap();
        let pane = PtyId::new();
        let mut interactive_block = make_block(pane, 1000, "vim notes.txt", b"distinctive_token");
        interactive_block.interactive = true;
        store.insert_block(&interactive_block).unwrap();

        // Output search misses — the alt-screen bytes aren't in the index.
        assert!(store
            .search(&SearchOptions {
                query: "distinctive_token".into(),
                limit: 10,
                offset: 0,
                ..Default::default()
            })
            .unwrap()
            .is_empty());
        // Command search still finds it.
        let hits = store
            .search(&SearchOptions {
                query: "vim".into(),
                limit: 10,
                offset: 0,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block.command.as_deref(), Some("vim notes.txt"));
    }

    #[test]
    fn search_filters_by_status() {
        let store = Store::open_in_memory().unwrap();
        let pane = PtyId::new();
        let mut ok_block = make_block(pane, 1000, "kubectl ok", b"");
        ok_block.exit_code = Some(0);
        store.insert_block(&ok_block).unwrap();
        let mut fail_block = make_block(pane, 2000, "kubectl fail", b"");
        fail_block.exit_code = Some(1);
        store.insert_block(&fail_block).unwrap();
        let mut aborted_block = make_block(pane, 3000, "kubectl killed", b"");
        aborted_block.aborted = true;
        aborted_block.exit_code = Some(-1);
        store.insert_block(&aborted_block).unwrap();

        let ok = store
            .search(&SearchOptions {
                query: "kubectl".into(),
                limit: 10,
                offset: 0,
                status: SearchStatus::Ok,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(ok.len(), 1);
        assert_eq!(ok[0].block.command.as_deref(), Some("kubectl ok"));

        let fail = store
            .search(&SearchOptions {
                query: "kubectl".into(),
                limit: 10,
                offset: 0,
                status: SearchStatus::Fail,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(fail.len(), 1);
        assert_eq!(fail[0].block.command.as_deref(), Some("kubectl fail"));

        let aborted = store
            .search(&SearchOptions {
                query: "kubectl".into(),
                limit: 10,
                offset: 0,
                status: SearchStatus::Aborted,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(aborted.len(), 1);
        assert_eq!(aborted[0].block.command.as_deref(), Some("kubectl killed"));
    }

    #[test]
    fn search_empty_query_with_filter_browses_history() {
        // "Show me every failure today" is a valid search even with no
        // text query. The store falls through to a non-FTS path that
        // orders by started_at_ms DESC.
        let store = Store::open_in_memory().unwrap();
        let pane = PtyId::new();
        let mut ok_block = make_block(pane, 1000, "ls", b"");
        ok_block.exit_code = Some(0);
        store.insert_block(&ok_block).unwrap();
        let mut fail_block = make_block(pane, 2000, "false", b"");
        fail_block.exit_code = Some(1);
        store.insert_block(&fail_block).unwrap();

        // Empty query + Fail filter → just the failed block.
        let hits = store
            .search(&SearchOptions {
                query: String::new(),
                limit: 10,
                offset: 0,
                status: SearchStatus::Fail,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block.command.as_deref(), Some("false"));
        // Filter-only mode has no FTS match → no snippet.
        assert!(hits[0].snippet.is_none());
    }

    #[test]
    fn search_empty_query_no_filter_returns_empty() {
        // Without a query AND without any active filter we still
        // return nothing — the search overlay's empty state is "type
        // to search", not "dump everything".
        let store = Store::open_in_memory().unwrap();
        let pane = PtyId::new();
        store
            .insert_block(&make_block(pane, 1000, "ls", b""))
            .unwrap();
        let hits = store
            .search(&SearchOptions {
                query: String::new(),
                limit: 10,
                offset: 0,
                ..Default::default()
            })
            .unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn search_filters_by_since_ms() {
        let store = Store::open_in_memory().unwrap();
        let pane = PtyId::new();
        store
            .insert_block(&make_block(pane, 1000, "old kubectl", b""))
            .unwrap();
        store
            .insert_block(&make_block(pane, 5000, "new kubectl", b""))
            .unwrap();
        let recent = store
            .search(&SearchOptions {
                query: "kubectl".into(),
                limit: 10,
                offset: 0,
                since_ms: Some(3000),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].block.command.as_deref(), Some("new kubectl"));
    }

    #[test]
    fn search_filters_by_cwd_exact() {
        let store = Store::open_in_memory().unwrap();
        let pane = PtyId::new();
        store
            .insert_block(&make_block_with(
                pane,
                1000,
                "kubectl get pods",
                b"",
                "/home/me/proj-a",
                "main",
            ))
            .unwrap();
        store
            .insert_block(&make_block_with(
                pane,
                2000,
                "kubectl get nodes",
                b"",
                "/home/me/proj-b",
                "main",
            ))
            .unwrap();
        let hits = store
            .search(&SearchOptions {
                query: "kubectl".into(),
                limit: 10,
                offset: 0,
                cwd: Some("/home/me/proj-a".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block.cwd.as_deref(), Some("/home/me/proj-a"));
    }

    #[test]
    fn search_filters_by_git_branch_exact() {
        let store = Store::open_in_memory().unwrap();
        let pane = PtyId::new();
        store
            .insert_block(&make_block_with(
                pane,
                1000,
                "kubectl get pods",
                b"",
                "/tmp",
                "main",
            ))
            .unwrap();
        store
            .insert_block(&make_block_with(
                pane,
                2000,
                "kubectl get nodes",
                b"",
                "/tmp",
                "feat/x",
            ))
            .unwrap();
        let hits = store
            .search(&SearchOptions {
                query: "kubectl".into(),
                limit: 10,
                offset: 0,
                git_branch: Some("feat/x".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block.git_branch.as_deref(), Some("feat/x"));
    }

    #[test]
    fn distinct_branches_returns_each_branch_most_recent_first() {
        let store = Store::open_in_memory().unwrap();
        let pane = PtyId::new();
        // Two appearances of "main", one of "feat/x", one of "feat/old".
        // The latest "main" timestamp (3000) is newer than "feat/x"'s
        // (2000), which beats "feat/old" (500).
        store
            .insert_block(&make_block_with(pane, 500, "a", b"", "/tmp", "feat/old"))
            .unwrap();
        store
            .insert_block(&make_block_with(pane, 1000, "b", b"", "/tmp", "main"))
            .unwrap();
        store
            .insert_block(&make_block_with(pane, 2000, "c", b"", "/tmp", "feat/x"))
            .unwrap();
        store
            .insert_block(&make_block_with(pane, 3000, "d", b"", "/tmp", "main"))
            .unwrap();
        let branches = store
            .distinct_branches_for(&SearchOptions::default())
            .unwrap();
        assert_eq!(branches, vec!["main", "feat/x", "feat/old"]);
    }

    #[test]
    fn distinct_branches_for_narrows_to_query_matches() {
        let store = Store::open_in_memory().unwrap();
        let pane = PtyId::new();
        // Two blocks mention "shax", on two branches.
        store
            .insert_block(&make_block_with(
                pane,
                1000,
                "cd repos/shax",
                b"",
                "/tmp",
                "feat/a",
            ))
            .unwrap();
        store
            .insert_block(&make_block_with(
                pane,
                2000,
                "ls repos/shax",
                b"",
                "/tmp",
                "feat/b",
            ))
            .unwrap();
        // A third block on `main` has nothing to do with "shax".
        store
            .insert_block(&make_block_with(
                pane,
                3000,
                "cargo test",
                b"",
                "/tmp",
                "main",
            ))
            .unwrap();
        let branches = store
            .distinct_branches_for(&SearchOptions {
                query: "shax".into(),
                limit: 50,
                offset: 0,
                ..Default::default()
            })
            .unwrap();
        // `main` is excluded because no `main` block matches the query.
        assert_eq!(branches, vec!["feat/b", "feat/a"]);
    }

    #[test]
    fn distinct_branches_for_ignores_the_branch_filter_itself() {
        // The faceted-search rule: picking a branch must not collapse
        // the dropdown to just that branch.
        let store = Store::open_in_memory().unwrap();
        let pane = PtyId::new();
        store
            .insert_block(&make_block_with(
                pane, 1000, "cd shax", b"", "/tmp", "feat/a",
            ))
            .unwrap();
        store
            .insert_block(&make_block_with(
                pane, 2000, "ls shax", b"", "/tmp", "feat/b",
            ))
            .unwrap();
        let branches = store
            .distinct_branches_for(&SearchOptions {
                query: "shax".into(),
                limit: 50,
                offset: 0,
                git_branch: Some("feat/a".into()),
                ..Default::default()
            })
            .unwrap();
        // Both still appear even though we picked `feat/a`.
        assert!(branches.contains(&"feat/a".to_owned()));
        assert!(branches.contains(&"feat/b".to_owned()));
    }

    #[test]
    fn distinct_branches_for_composes_with_cwd_filter() {
        let store = Store::open_in_memory().unwrap();
        let pane = PtyId::new();
        // Same query word in different cwds on different branches.
        store
            .insert_block(&make_block_with(pane, 1000, "cd shax", b"", "/x", "feat/a"))
            .unwrap();
        store
            .insert_block(&make_block_with(pane, 2000, "cd shax", b"", "/y", "feat/b"))
            .unwrap();
        let branches = store
            .distinct_branches_for(&SearchOptions {
                query: "shax".into(),
                limit: 50,
                offset: 0,
                cwd: Some("/x".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(branches, vec!["feat/a"]);
    }

    #[test]
    fn distinct_branches_skips_null_and_empty_branches() {
        let store = Store::open_in_memory().unwrap();
        let pane = PtyId::new();
        // The PersistedBlock constructor in `make_block_with` always
        // sets a branch — bypass it by hand for the null / empty cases.
        let mut nullish = make_block_with(pane, 1000, "a", b"", "/tmp", "main");
        nullish.git_branch = None;
        store.insert_block(&nullish).unwrap();
        let mut empty = make_block_with(pane, 2000, "b", b"", "/tmp", "");
        empty.git_branch = Some(String::new());
        store.insert_block(&empty).unwrap();
        store
            .insert_block(&make_block_with(pane, 3000, "c", b"", "/tmp", "main"))
            .unwrap();
        assert_eq!(
            store
                .distinct_branches_for(&SearchOptions::default())
                .unwrap(),
            vec!["main"]
        );
    }

    #[test]
    fn search_empty_query_with_cwd_filter_browses_history() {
        // Browse-by-filter path with cwd narrowing.
        let store = Store::open_in_memory().unwrap();
        let pane = PtyId::new();
        store
            .insert_block(&make_block_with(pane, 1000, "a", b"", "/x", "main"))
            .unwrap();
        store
            .insert_block(&make_block_with(pane, 2000, "b", b"", "/y", "main"))
            .unwrap();
        let hits = store
            .search(&SearchOptions {
                query: "".into(),
                limit: 10,
                offset: 0,
                cwd: Some("/x".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block.command.as_deref(), Some("a"));
        assert!(hits[0].snippet.is_none());
    }

    #[test]
    fn search_returns_pane_id_and_snippet_for_output_hits() {
        let store = Store::open_in_memory().unwrap();
        let pane = PtyId::new();
        store
            .insert_block(&make_block(
                pane,
                1000,
                "cat",
                b"before the magic_token after the token line\n",
            ))
            .unwrap();
        let hits = store
            .search(&SearchOptions {
                query: "magic_token".into(),
                limit: 10,
                offset: 0,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(hits.len(), 1);
        // The pane id round-trips so the UI can route jump-to-pane.
        assert_eq!(hits[0].pane_id, pane);
        // Snippet marks the matched token.
        let snippet = hits[0].snippet.as_deref().expect("snippet present");
        assert!(
            snippet.contains("<mark>magic_token</mark>"),
            "expected <mark>…</mark> wrapper in snippet, got: {snippet:?}",
        );
    }

    #[test]
    fn search_orders_results_newest_first() {
        let store = Store::open_in_memory().unwrap();
        let pane = PtyId::new();
        store
            .insert_block(&make_block(pane, 1000, "kubectl get pods", b""))
            .unwrap();
        store
            .insert_block(&make_block(pane, 2000, "kubectl get nodes", b""))
            .unwrap();
        store
            .insert_block(&make_block(pane, 3000, "kubectl describe", b""))
            .unwrap();
        let hits = store
            .search(&SearchOptions {
                query: "kubectl".into(),
                limit: 10,
                offset: 0,
                ..Default::default()
            })
            .unwrap();
        let times: Vec<u64> = hits.iter().map(|h| h.block.started_at_ms).collect();
        assert_eq!(times, vec![3000, 2000, 1000], "newest first");
    }

    #[test]
    fn search_paginates_with_limit_and_offset() {
        let store = Store::open_in_memory().unwrap();
        let pane = PtyId::new();
        for i in 0..5 {
            store
                .insert_block(&make_block(pane, 1000 + i, &format!("kubectl c{i}"), b""))
                .unwrap();
        }
        assert_eq!(
            store
                .search(&SearchOptions {
                    query: "kubectl".into(),
                    limit: 2,
                    offset: 0,
                    ..Default::default()
                })
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            store
                .search(&SearchOptions {
                    query: "kubectl".into(),
                    limit: 2,
                    offset: 2,
                    ..Default::default()
                })
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            store
                .search(&SearchOptions {
                    query: "kubectl".into(),
                    limit: 2,
                    offset: 4,
                    ..Default::default()
                })
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn v1_database_migrates_to_v2_on_open() {
        // Hand-craft a v1 schema (no interactive column, no app_state),
        // then re-open and confirm both pieces of v2 are present and
        // historical rows default to interactive=false.
        let tmpdir = tempfile::tempdir().unwrap();
        let path = tmpdir.path().join("shax.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                r#"
                CREATE TABLE blocks (
                    id TEXT PRIMARY KEY, pane_id TEXT NOT NULL, session_id TEXT,
                    command TEXT, argv TEXT, cwd TEXT, git_branch TEXT, host TEXT,
                    exit_code INTEGER, started_at_ms INTEGER NOT NULL,
                    ended_at_ms INTEGER, duration_ms INTEGER,
                    aborted INTEGER NOT NULL DEFAULT 0, output BLOB
                );
                INSERT INTO blocks (id, pane_id, command, started_at_ms, aborted)
                    VALUES (
                        '11111111-1111-1111-1111-111111111111',
                        '22222222-2222-2222-2222-222222222222',
                        'old', 500, 0
                    );
                "#,
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
        }
        let store = Store::open(&path).expect("v1 should upgrade on open");
        let loaded = store.load_recent(10).unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(
            !loaded[0].interactive,
            "v1 row should default to non-interactive"
        );
        // app_state table exists and is empty after the upgrade.
        assert!(store.load_app_state().unwrap().is_none());
        store.save_app_state(r#"{"tabs":[]}"#, 1).unwrap();
        assert!(store.load_app_state().unwrap().is_some());
        // The historical row was also indexed by the v3 step on the same
        // open, so search picks it up.
        let hits = store
            .search(&SearchOptions {
                query: "old".into(),
                limit: 10,
                offset: 0,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            hits.len(),
            1,
            "v1 historical row should be back-filled into FTS"
        );
    }
}
