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
        // blocks-only schema; v2 adds the per-block `interactive` flag and
        // the `app_state` table for tab/layout persistence. Older databases
        // (v0 from before the version was set, or v1) migrate forward on
        // open via the matching branch below.
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

        conn.pragma_update(None, "user_version", 2)?;
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
        conn.execute(
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
                block.id.to_string(),
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
        Ok(())
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

    /// Return the most recent `limit` blocks across all panes, oldest-first
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
        PersistedBlock {
            id: BlockId(Uuid::new_v4()),
            pane_id,
            command: Some(command.to_owned()),
            cwd: Some("/tmp".to_owned()),
            git_branch: Some("main".to_owned()),
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
                    VALUES ('11111111-1111-1111-1111-111111111111', 'aaaa', 'old', 500, 0);
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
    }
}
