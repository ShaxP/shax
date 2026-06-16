# 05 Search and the data model

Searchable history is the headline feature. The same store is the assistant's memory.

## Storage

SQLite on the user's machine, local-first. Three concerns:

- **Blocks table.** One row per block, the record from `03-blocks-and-osc133.md` (id, pane_id, session_id, command, argv as JSON, cwd, git_branch, host, exit_code, started_at, ended_at, duration_ms, state).
- **Output.** Captured stdout and stderr per block. Cap per-block size; for large output, store a capped head and tail plus a spill file on disk referenced by `output_ref`, and never load the whole thing into memory to render. The view layer virtualizes; the data layer streams.
- **Indexes.** An FTS5 virtual table over the command text and the captured output for literal full-text search. A `sqlite-vec` table of embeddings for semantic search (added at the semantic-search milestone; the schema reserves for it from the start).

## What is searchable

- The command line and argv.
- The output, not just the command. "Where did I see that error string" is often more useful than the command.
- Metadata: exit code, cwd and repo, git branch, time range, pane and session, host, duration.

## Search modes

- **Literal and fuzzy** (always available, cheap): FTS5 plus a fuzzy match for "I know roughly what I typed."
- **Semantic** (added at M7): embeddings via `sqlite-vec` for "that docker command that fixed the port conflict."
- **Hybrid:** combine literal and semantic, rank together. Filters compose with any mode.

## Example queries the design must serve

- Commands that failed (`exit_code != 0`) in this repo.
- Everything run in `~/project` this week.
- Every `kubectl` ever run, across panes and sessions.
- A directory's history: what was done in this cwd, regardless of pane.

## Indexing pipeline

On block completion (state Completed), write the block row, insert into the FTS5 index, and, at M7, enqueue an embedding job. Indexing is off the hot path; the live terminal never waits on it.

## Embeddings and privacy

Semantic search needs embeddings. Default to a local embedding model so history never leaves the machine. If the user has configured a Claude auth lane and opts in, embeddings may be generated through it, but this is opt-in and clearly stated. History is private by default; there is no telemetry.

## The index as the assistant's memory

The assistant (see `09`) reads this store as its long-term memory. "Why did this fail" is answered by retrieving the relevant prior blocks, not by guessing. Design the query API so the assistant and the human use the same retrieval surface.

## Performance

Searching thousands to millions of blocks must stay fast. Index on completion, keep FTS5 tokenization sensible for code and paths, paginate results, and never block the UI on a query.
