# Kilo Herdr Engineering Workflow

A portable Kilo configuration package in which a Kilo coordinator runs three
independent Herdr review workers:

- test and build verification
- engineering code review
- human readability review

The Kilo coordinator receives durable completion notifications, evaluates
findings, fixes accepted blocking issues, and can retry only the affected
reviewer. The trusted worker profiles cover Kilo, Claude Code, and Codex;
the current no-map `workflow_start` path launches Kilo workers by default.

## What This Solves

This workflow lets multiple independent reviews run simultaneously inside Herdr
while still allowing an engineer to redirect or directly cancel any reviewer.
The result is a more readable, durable process for producing pull requests and
commits, helping engineers stay connected to the code as codebases grow.

## Workflow

The full engineering cycle is:

1. **Plan** the work and define the intended outcome.
2. Use the **task-planning skill** to turn the plan into small, ordered Task Cards with acceptance criteria and verification requirements.
3. Run **`/implement-task`** for each Task Card or a set of cards. At a stable implementation checkpoint, the Kilo coordinator starts parallel test, code, and readability reviews in Herdr.

Reviewers report durable results, can be redirected or cancelled directly, and affected reviewers can be retried without restarting the entire workflow.

## Included

- `/implement-task` Kilo coordinator command
- `workflow_start`, `workflow_status`, `workflow_send`, `workflow_stop`, and `workflow_retry` tools
- Herdr-to-Kilo agent-state integration
- Windows long-prompt launcher shim for Kilo workers
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

## Worker Harnesses

Phase 1 defines `kilo`, `claude`, and `codex` as trusted worker harnesses. Kilo
is the only supported coordinator. The current `workflow_start` schema has no
worker-selection map, so its no-map behavior is three Kilo workers, one each
for tests, code review, and readability. The trusted profiles and persisted
worker definitions are ready for configurable worker selection in the later
runtime work.

When Claude Code or Codex worker selection is enabled, those workers require
their executable and corresponding Herdr integration. Install missing
prerequisites explicitly; the workflow does not install them automatically.
For example:

```text
herdr integration install claude
herdr integration install codex
```

Review-only workers use no-write modes where the harness supports them:

- Claude Code uses plan mode.
- Codex uses a read-only sandbox without approval escalation.
- Kilo uses prompt and tracked-source-checkpoint enforcement. This is weaker
  enforcement and does not guarantee that Kilo cannot write files.

Test verification workers retain the permissions needed to run checks and
write generated artifacts. Status output identifies each worker harness and
its enforcement strength.

If tracked source changes during a worker attempt, the captured report is
marked `stale`. It remains diagnostic evidence, does not count toward review
completion, and requires `workflow_retry` to capture a fresh checkpoint and
rerun that worker.

## Install On Windows

```powershell
git clone <repository-url>
Set-Location kilo-herdr-engineering-workflow
.\scripts\install.ps1
```

The installer runs `npm ci`, runs the unit tests, and sets the user-level `KILO_CONFIG_DIR` to this checkout. Start a new terminal after installation.

Global scope is the default and can also be selected explicitly with `-Scope Global`.

## Install On macOS Or Linux

```bash
git clone <repository-url>
cd kilo-herdr-engineering-workflow
sh ./scripts/install.sh
```

The installer runs `npm ci`, runs the unit tests, and adds a marked `KILO_CONFIG_DIR` block to the appropriate shell profile. Start a new shell after installation.

Use `--profile /path/to/profile` when automatic profile selection is not suitable.

Global scope is the default and can also be selected explicitly with `--scope global`.

## Install For One Project

Project scope installs the workflow into the target project's `.kilo` directory. It does not set `KILO_CONFIG_DIR` or modify a shell profile.

Windows:

```powershell
.\scripts\install.ps1 -Scope Project -ProjectPath C:\path\to\project
```

macOS or Linux:

```bash
sh ./scripts/install.sh --scope project --project /path/to/project
```

Project installation runs `npm ci` in a staging directory and copies the plugin dependency into the project's `.kilo/node_modules`. Use `-SkipDependencies` or `--skip-dependencies` only when that dependency is already resolvable there.

Project installation refuses to proceed when the global workflow plugin is already active, because Kilo would load duplicate workflow tools. Remove the global installation before installing the project-scoped copy.

## Existing Kilo Configuration

Kilo deep-merges this additional configuration directory with normal global and project configuration. Global installation does not modify `~/.config/kilo`, `~/.kilo`, project `.kilo` files, or provider credentials. Project installation intentionally writes its payload to the selected project's `.kilo` directory after checking for conflicts.

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

For a project-scoped installation, pass the same project path:

```powershell
.\scripts\uninstall.ps1 -Scope Project -ProjectPath C:\path\to\project
```

```bash
sh ./scripts/uninstall.sh --scope project --project /path/to/project
```

Global uninstall removes only the registration created by the installer. Project uninstall removes only unchanged files recorded by its project manifest. Neither mode deletes existing Kilo configuration or workflow history in other projects.
