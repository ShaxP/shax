/// <reference types="vite/client" />

// `@xterm/addon-ligatures@0.10.0` ships an ESM-only entry
// (`.mjs`) with no matching `.d.ts`. TerminalPane imports
// the runtime from the deep `.mjs` path to dodge the
// upstream `main`-points-at-missing-`.js` bug; TypeScript's
// module resolver needs this shim to accept the deep path.
// Types themselves come from the package root import in the
// same file — this declaration only exists to silence TS7016.
declare module "@xterm/addon-ligatures/lib/addon-ligatures.mjs" {
  export { LigaturesAddon } from "@xterm/addon-ligatures";
}
