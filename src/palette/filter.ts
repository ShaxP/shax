/**
 * Fuzzy-filter helper for the palette.
 *
 * M8.1 ships the simplest thing that produces good rankings for
 * short query strings against short entry names + descriptions:
 * substring match on a lowercased haystack, with a score bump
 * when the query hits the name vs. only the description.
 *
 * The spec calls out "fuzzy matching (same trigram approach as
 * M3's history search)" — trigram fuzz is a natural upgrade
 * once we have real user data on what queries feel too strict.
 * Substring already handles `chk` → `git checkout` if we split
 * the query into single-char subsequences, but the M3 trigram
 * pipeline pays off at scale we haven't hit yet.
 */

import type { PaneCommand } from "./registry";

/** A palette entry ranked by relevance to a query. */
export interface RankedCommand {
  command: PaneCommand;
  /** Higher = more relevant. Zero means "no match, hide". */
  score: number;
}

/** Rank the given commands against `query`. Empty query returns
 *  every command with score `1` so the palette shows the full
 *  list before the user has typed anything. Zero-score entries
 *  are filtered out. Sort stability preserves registration
 *  order among ties. */
export function rankCommands(commands: PaneCommand[], query: string): RankedCommand[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) {
    return commands.map((command) => ({ command, score: 1 }));
  }
  const scored: RankedCommand[] = commands
    .map((command) => ({ command, score: scoreOne(command, q) }))
    .filter((r) => r.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** Score one command against a lowercased query. */
function scoreOne(command: PaneCommand, q: string): number {
  const name = command.name.toLowerCase();
  const description = command.description.toLowerCase();
  // Prefix hit on name is the strongest signal.
  if (name.startsWith(q)) return 100;
  // Word-start hit inside the name — treat spaces / hyphens as
  // word boundaries so `st` matches "git status" (via the `s`
  // in `status`, not just via the leading `g`).
  if (containsWordStart(name, q)) return 80;
  // Substring anywhere in the name.
  if (name.includes(q)) return 60;
  // Fallback: substring in the description.
  if (description.includes(q)) return 30;
  return 0;
}

function containsWordStart(haystack: string, needle: string): boolean {
  const parts = haystack.split(/[\s\-_]+/);
  return parts.some((p) => p.startsWith(needle));
}
