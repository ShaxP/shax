# Design

This folder holds the visual design for Shax, produced in Claude Design and exported here. It is the visual source of truth for the frontend.

## What goes here

Export from Claude Design (the Export button, upper right) and place the result in this folder:

- **Download as .zip** then extract here for a versioned copy the agent team always reads. This gives the raw assets: the HTML and CSS prototype, images, any design-system or token files, and the export README.
- Or use **Handoff to Claude Code** / **Send to local coding agent** to push the bundle straight into your Claude Code session, then have it write the assets into this folder.

Keep the export README and any token or design-system files; the agents use them to interpret intent.

## How it is used

See `../specs/13-design.md`. In short: the frontend engineer builds the UI to match what is in this folder, and the orchestrator checks UI work against it. Behavior is defined by the specs; look and layout are defined here. Where they conflict, raise it with the orchestrator.

## Keeping designs production-aware (optional)

Claude Design can read this repository (give it the GitHub URL) and extract a design system from the code and these assets, so future designs start from the real styles automatically. Useful once the first screens are built.
