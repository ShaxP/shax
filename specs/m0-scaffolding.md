# M0 Scaffolding (detailed)

This expands milestone M0 from `12-roadmap-milestones.md` into a buildable recipe. The team should create the files described here as the M0 PR. Everything below is the intended content; copy the blocks, adjust pinned versions to the current stable, and keep the script names exactly as written because `.github/workflows/ci.yml` depends on them.

## Goal and exit criteria

A repo that boots an empty Tauri window and a green pipeline. M0 is done when:

- `pnpm tauri:dev` opens an empty window locally.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm test:e2e` all pass.
- `cargo fmt --check`, `cargo clippy -D warnings`, and `cargo test` pass in `src-tauri`.
- CI is green on macOS, Windows, and Linux.
- A trivial Rust test and a trivial Playwright test exist and pass.
- lefthook hooks are installed and run on commit and push.

## Step 1: scaffold the Tauri 2 app

From the repo root (the folder already contains specs, .claude, etc.):

```
pnpm create tauri-app@latest .
```

Choices: project name `shax`, frontend `TypeScript / JavaScript`, framework `React`, flavor `TypeScript`, package manager `pnpm`. This generates the frontend at the repo root (`src/`, `index.html`, `vite.config.ts`, `tsconfig.json`) and the Rust host in `src-tauri/` (`Cargo.toml`, `tauri.conf.json`, `src/main.rs`, `src/lib.rs`).

Then verify it runs:

```
pnpm install
pnpm tauri:dev
```

Keep the generated structure. The module subfolders in `11-tech-stack-and-conventions.md` (`pty/`, `vt/`, `mux/`, etc., and the frontend `panes/`, `blocks/`, etc.) are created empty in Step 11 and filled in M1 onward.

## Step 2: package.json scripts

Ensure the root `package.json` contains these scripts exactly (CI references `lint`, `typecheck`, `test`, `test:e2e`):

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "tauri": "tauri",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "prepare": "lefthook install"
  },
  "packageManager": "pnpm@9.15.0",
  "volta": {
    "node": "20.18.1",
    "pnpm": "9.15.0"
  }
}
```

Set `packageManager` and the Volta pins to the exact current versions you are using (Volta requires exact versions, not ranges). `packageManager` is what `pnpm/action-setup` reads in CI, and node 20 matches the CI matrix.

Dev dependencies to add for the tooling below:

```
pnpm add -D eslint @eslint/js typescript-eslint eslint-plugin-react eslint-plugin-react-hooks prettier vitest jsdom @testing-library/react @testing-library/jest-dom @playwright/test lefthook
```

## Step 3: TypeScript strictness

In the root `tsconfig.json`, ensure `compilerOptions` includes (on top of what the template provides):

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true
  }
}
```

`no any` is enforced by ESLint (Step 4), not the compiler, but these options catch the rest. See CLAUDE.md for the rule.

## Step 4: ESLint (flat config) and Prettier

`eslint.config.js`:

```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist", "src-tauri/target", "playwright-report", "test-results"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true } },
    plugins: { react, "react-hooks": reactHooks },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn"
    }
  }
);
```

`.prettierrc.json`:

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100
}
```

## Step 5: Rust toolchain and lints

`rust-toolchain.toml` at the repo root (pin to the current stable; check `rustc --version`):

```toml
[toolchain]
channel = "1.86.0"
components = ["rustfmt", "clippy"]
profile = "minimal"
```

In `src-tauri/Cargo.toml`, set the edition and turn clippy warnings into errors at the crate level so local builds match CI:

```toml
[package]
edition = "2021"

[lints.clippy]
all = "deny"
```

Keep dependencies to whatever the scaffold added for M0. The real crates (`portable-pty`, `vte`, `rusqlite`, `tokio`, `thiserror`, etc.) come in M1; do not add them now.

## Step 6: Vitest and a trivial unit test

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"]
  }
});
```

`src/smoke.test.ts`:

```ts
import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

## Step 7: Playwright and a trivial e2e test

For M0, Playwright exercises the web frontend served by Vite. Full native-window end-to-end (via `tauri-driver` and WebDriver) is a later upgrade; note it and move on.

`playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  use: { baseURL: "http://localhost:1420" },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI
  }
});
```

Port 1420 is Tauri's default Vite dev port; confirm it against the generated `vite.config.ts` and `tauri.conf.json`.

`e2e/smoke.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("app loads", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();
});
```

## Step 8: lefthook

`lefthook.yml`. Keep pre-commit fast (staged files only); put the heavier full checks on pre-push.

```yaml
pre-commit:
  parallel: true
  commands:
    prettier:
      glob: "*.{ts,tsx,js,jsx,json,md,css,yml,yaml}"
      run: pnpm prettier --check {staged_files}
    eslint:
      glob: "*.{ts,tsx,js,jsx}"
      run: pnpm eslint {staged_files}
    rustfmt:
      glob: "*.rs"
      run: cargo fmt --manifest-path src-tauri/Cargo.toml -- --check

pre-push:
  parallel: false
  commands:
    typecheck:
      run: pnpm typecheck
    clippy:
      run: cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
    test:
      run: pnpm test
```

Run `pnpm install` then `pnpm prepare` (or `lefthook install`) once to wire the git hooks.

## Step 9: .gitignore and .editorconfig

Ensure `.gitignore` covers:

```
node_modules
dist
src-tauri/target
.DS_Store
*.log
playwright-report
test-results
.env
.env.*
```

`.editorconfig`:

```
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2

[*.rs]
indent_size = 4
```

## Step 10: module skeleton

Create the directory skeleton from `11-tech-stack-and-conventions.md` so the structure exists and imports resolve. Empty Rust modules need a file; use minimal `mod.rs` stubs or a `lib.rs` that declares the modules. Frontend folders can hold an `index.ts` placeholder. Do not implement behavior; this is scaffolding only.

Backend (`src-tauri/src/`): `pty/`, `vt/`, `blocks/`, `mux/`, `store/`, `search/`, `agent/`, `safety/`, `ipc/`.
Frontend (`src/`): `panes/`, `blocks/`, `viewer/`, `formatters/`, `widgets/`, `search/`, `assistant/`, `settings/`, `lib/`.

## Step 11: confirm CI alignment

`.github/workflows/ci.yml` already exists and expects: the four pnpm scripts above, `pnpm install --frozen-lockfile` (so commit the `pnpm-lock.yaml`), and cargo `fmt`, `clippy`, and `test` run with working directory `src-tauri`. After scaffolding, push the branch and confirm the pipeline is green on all three platforms before opening the PR.

## M0 acceptance checklist

1. `pnpm tauri:dev` opens an empty window.
2. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e` pass locally.
3. `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` pass in `src-tauri`.
4. lefthook hooks fire on commit and push.
5. `pnpm-lock.yaml` is committed.
6. CI is green on macOS, Windows, and Linux.
7. A PR is open, scoped to scaffolding only, linking this spec. Not merged.
