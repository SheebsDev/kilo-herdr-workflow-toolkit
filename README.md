# Kilo Herdr Engineering Workflow

A portable Kilo configuration package that coordinates implementation work with three independent Herdr review sessions:

- test and build verification
- engineering code review
- human readability review

The coordinator receives durable completion notifications, evaluates findings, fixes accepted blocking issues, and can retry only the affected reviewer.

## What This Solves

This workflow lets multiple independent reviews run simultaneously inside Herdr while still allowing an engineer to redirect or directly cancel any reviewer. The result is a more readable, durable process for producing pull requests and commits, helping engineers stay connected to the code as codebases grow.

## Workflow

The full engineering cycle is:

1. **Plan** the work and define the intended outcome.
2. Use the **task-planning skill** to turn the plan into small, ordered Task Cards with acceptance criteria and verification requirements.
3. Run **`/implement-task`** for each Task Card or a set of cards. At a stable implementation checkpoint, the command starts parallel test, code, and readability reviews in Herdr.

Reviewers report durable results, can be redirected or cancelled directly, and affected reviewers can be retried without restarting the entire workflow.

## Included

- `/implement-task` Kilo command
- `workflow_start`, `workflow_status`, `workflow_send`, `workflow_stop`, and `workflow_retry` tools
- Herdr-to-Kilo agent-state integration
- Windows long-prompt launcher shim
- code review, readability review, test verification, and task planning skills
- Windows and Unix registration scripts
- GitHub Actions verification on Windows and Linux

The repository intentionally excludes model/provider configuration, credentials, broad permissions, workflow run data, `node_modules`, and project-specific skills.

## Requirements

- Kilo Code compatible with `@kilocode/plugin` 7.4.20
- Herdr CLI available as `herdr`
- Node.js 22.22.2 or newer and npm
- Git

The parallel workflow must be started from a Kilo session running inside Herdr. Ordinary Kilo sessions can load the package, but `workflow_start` will reject launches without Herdr's workspace environment.

## Install On Windows

```powershell
git clone <repository-url>
Set-Location kilo-herdr-engineering-workflow
.\scripts\install.ps1
```

The installer runs `npm ci`, runs the unit tests, and sets the user-level `KILO_CONFIG_DIR` to this checkout. Start a new terminal after installation.

## Install On macOS Or Linux

```bash
git clone <repository-url>
cd kilo-herdr-engineering-workflow
sh ./scripts/install.sh
```

The installer runs `npm ci`, runs the unit tests, and adds a marked `KILO_CONFIG_DIR` block to the appropriate shell profile. Start a new shell after installation.

Use `--profile /path/to/profile` when automatic profile selection is not suitable.

## Existing Kilo Configuration

Kilo deep-merges this additional configuration directory with normal global and project configuration. The installers do not modify `~/.config/kilo`, `~/.kilo`, `.kilo`, or provider credentials.

Installation stops when either of these could cause an ambiguous setup:

- `KILO_CONFIG_DIR` already points somewhere else
- a workflow plugin exists in the supported global `plugin/` or `plugins/` directories under `~/.config/kilo`, `~/.kilo`, or `~/.kilocode`

Resolve or intentionally migrate that setup before using `-Force` on Windows or `--force` on Unix. Loading two copies of the workflow plugin can register duplicate tool names.

## Use

Launch Kilo inside a Herdr workspace, then invoke:

```text
/implement-task path/to/TASK-001.md
```

The command tells the implementation agent to reach a stable checkpoint and call `workflow_start`. Herdr opens three unfocused worker tabs. Completed reports are persisted under the target project's `.workflow/runs/` directory before worker tabs are closed.

The workflow also supports direct tool-driven control:

- inspect current state with `workflow_status`
- redirect a worker with `workflow_send`
- terminate a worker with `workflow_stop`
- restart an affected worker with `workflow_retry`

## Update

```bash
git pull
npm ci
npm test
```

The checkout path remains registered, so no reinstall is needed unless the repository moves.

## Uninstall

Windows:

```powershell
.\scripts\uninstall.ps1
```

macOS or Linux:

```bash
sh ./scripts/uninstall.sh
```

Uninstalling removes only the registration created by the installer. It does not delete this checkout, existing Kilo configuration, or workflow history in other projects.
