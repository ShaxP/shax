# 13 Design

The visual design lives in `/design`, exported from Claude Design. It is the visual source of truth for the user interface.

## How design and specs relate

- The specs (`00` through `12`) define behavior: what the product does and the rules it must obey.
- `/design` defines look and layout: how it should appear and feel.
- The frontend engineer builds the UI to match `/design`; the orchestrator reviews UI work against it. Do not invent visuals when a design exists for that surface.
- Where the design and a spec conflict, raise it with the orchestrator rather than silently choosing one. Some conflicts are real design bugs; some are non-negotiable behaviors the design must accommodate (below).

## Non-negotiables the design must honor

These come from CLAUDE.md and the rendering model and cannot be designed away:

- Every rich or formatted block keeps an always-available raw toggle (the fidelity contract).
- The permission and approval dialog (`10`) is a real, first-class component, not an afterthought.
- Interactive widgets show their actions as the visible commands they will emit (`08`).
- Both dark and light modes are required for every surface.

## Surface map

The designed surfaces map to the build as follows:

- Main shell, panes, tabs -> `01`, `04`, frontend `panes/`.
- The block (states, raw/formatted toggle, metadata) -> `02`, `03`, frontend `blocks/`.
- Interactive widgets (git diff, git status, ls) -> `08`, frontend `widgets/`.
- File viewer, markdown, images -> `06`, frontend `viewer/`.
- Search surface -> `05`, frontend `search/`.
- Assistant and the approval gate -> `09`, `10`, frontend `assistant/`.
- Settings, including the two auth lanes -> `09`, frontend `settings/`.
- Onboarding and empty states -> frontend, first-run flows.

## Process

When new designs arrive, re-export into `/design` (replacing or versioning the prior export) and note in the PR which surfaces changed so the frontend engineer can reconcile.
