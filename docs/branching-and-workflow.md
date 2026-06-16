# Branching and workflow

Trunk-based development. The goal is a always-releasable `main`, small reviewable changes, and a linear, readable history.

## Branches

- `main` is the trunk and is always releasable. CI must be green on it at all times.
- Work happens on short-lived branches off `main`, named by type:
  - `feat/<short-desc>` a new capability
  - `fix/<short-desc>` a bug fix
  - `chore/<short-desc>` tooling, deps, config
  - `docs/<short-desc>` docs and specs
  - `refactor/<short-desc>` behavior-preserving changes
  - `test/<short-desc>` tests only
- Branches are short-lived. Open a PR early, keep it small, merge or close within days, not weeks.

## Commits

Conventional Commits, so history is machine-readable and changelogs and SemVer can be automated later.

```
<type>(<optional scope>): <summary in present tense>

<optional body explaining why>
```

Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`.
Examples: `feat(mux): add vertical split`, `fix(vt): handle alt-screen exit mid-command`.

## Pull requests

- One logical change per PR. If you cannot describe it in a sentence, split it.
- The description links the spec section the change implements or follows.
- CI (fmt, clippy `-D warnings`, lint, typecheck, tests on all three platforms) must pass.
- Squash-merge so `main` stays linear; the squash message follows Conventional Commits.
- Agents open PRs but never merge. The human reviews and merges.
- Never force-push `main`.

## Versioning and releases

- SemVer. Tag releases `vMAJOR.MINOR.PATCH`.
- Pre-1.0 (during the milestones) we stay on `0.x`; breaking changes bump the minor.
- Automated changelog and release tooling (for example release-please or changesets) is added later, not on day one. Until then, tag manually at milestone boundaries.

## CI

`.github/workflows/ci.yml` runs on every PR and on pushes to `main`, across macOS, Windows, and Linux. A red pipeline blocks merge.
