/**
 * Shared types for the palette-command sandbox.
 *
 * `CommunityCommandContext` is the snapshot the host sends into
 * a Worker for the buildPanel / buildCommand phases. It's a
 * strict subset of `PaneContext` — `ptyId` is deliberately
 * omitted (it's a live handle the sandbox has no legitimate use
 * for, and passing it would tempt future authors to grow the
 * worker's capability surface).
 */

export interface CommunityCommandContext {
  readonly cwd: string | null;
  readonly branch: string | null;
  readonly gitRoot: string | null;
}
