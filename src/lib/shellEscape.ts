/**
 * POSIX shell path escape.
 *
 * Used anywhere a shax component composes a shell command from a
 * filesystem path (git-status widget, ls widget, palette's cd
 * browser, later commands). Consolidated here so a single copy
 * carries the escaping contract.
 *
 * Strategy: if the path is entirely made of characters the shell
 * treats as bare word literals, return it unchanged so the
 * scrollback stays readable. Otherwise wrap in single quotes and
 * escape embedded single quotes with `'\''`. Sufficient for
 * anything paths produced by `git status` or a directory listing
 * can contain, and matches the shape most users learn to type.
 */

/** True when `s` contains only characters safe as a bare shell word. */
const SAFE = /^[A-Za-z0-9_./-]+$/;

export function shellEscape(path: string): string {
  if (SAFE.test(path)) return path;
  return `'${path.replace(/'/g, "'\\''")}'`;
}
