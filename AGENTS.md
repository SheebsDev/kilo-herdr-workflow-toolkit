# Repository Guide

## Purpose

- This repository packages one Kilo, Claude Code, and Codex engineering verification workflow for Herdr.
- `plugin/workflow.ts` exposes the workflow tools and `plugin/workflow/` contains their implementation.
- `core/` owns the host-neutral workflow service, installers, ownership contract, and MCP support.
- `plugin/herdr-agent-state.js` reports Kilo session state to Herdr.
- `command/implement-task.md` coordinates implementation and parallel review.
- `launcher/` transports long initial prompts on Windows.

## Development

- Use Node.js 22.22.2 or newer and install dependencies with `npm ci`.
- Run the full runtime, MCP, adapter, ownership, transaction, and installer suites with `npm test`.
- Run the focused cross-platform installer matrix with `npm run test:installer`.
- Keep runtime state under each target project's `.workflow/` directory; never commit it here.
- Do not add provider credentials, user permissions, machine-specific paths, or generated dependencies.
- Keep coordinator orchestration shared across Kilo, Claude Code, and Codex; adapters only translate host context and tool protocols.
- Keep Windows-specific launch handling isolated in `launcher/`; non-Windows launches submit prompts through Herdr directly.

## Packaging

- Kilo discovers commands, skills, and plugins when `KILO_CONFIG_DIR` points to this repository.
- Global installation registers the checkout in place. Moving the checkout after installation requires running the global installer again.
- User Claude and Codex registrations remain checkout-backed; project installations copy the self-contained runtime below `.agents/toolkits/kilo-herdr-engineering-workflow` and use thin harness payloads.
- Project installation copies the Kilo payload into the target project's `.kilo` directory and does not modify global environment configuration.
- Preserve compatibility with an existing global Kilo configuration. Installation must not copy over or delete user configuration.
- Installer ownership and hash records are authoritative for update and uninstall; modified or unrelated content must be retained.
- Never remove `.workflow` history, and never invent cross-pane recovery or supervision after all coordinator hosts have exited.
