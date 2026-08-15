# Repository Guide

## Purpose

- This repository packages the Kilo and Herdr engineering verification workflow.
- `plugin/workflow.ts` exposes the workflow tools and `plugin/workflow/` contains their implementation.
- `plugin/herdr-agent-state.js` reports Kilo session state to Herdr.
- `command/implement-task.md` coordinates implementation and parallel review.
- `launcher/` transports long initial prompts on Windows.

## Development

- Use Node.js 22.22.2 or newer and install dependencies with `npm ci`.
- Run the workflow state tests with `npm test`.
- Keep runtime state under each target project's `.workflow/` directory; never commit it here.
- Do not add provider credentials, user permissions, machine-specific paths, or generated dependencies.
- Keep Windows-specific launch handling isolated in `launcher/`; non-Windows launches submit prompts through Herdr directly.

## Packaging

- Kilo discovers commands, skills, and plugins when `KILO_CONFIG_DIR` points to this repository.
- The installers register the checkout in place. Moving the checkout after installation requires running the installer again.
- Preserve compatibility with an existing global Kilo configuration. Installation must not copy over or delete user configuration.
