# Kilo Herdr Engineering Workflow

This checkout provides one durable engineering-verification workflow for Kilo
Code, Claude Code, and Codex coordinators running inside Herdr. All three
coordinators use the same host-neutral workflow service and the same five
operations. Claude Code and Codex access it through one local stdio MCP server;
Kilo uses the thin plugin adapter.

The default workflow starts three independent workers:

- `tests`: test and build verification
- `code-review`: engineering correctness review
- `readability`: human readability and maintainability review

Workers may use Kilo, Claude, or Codex independently. There is no
harness-specific orchestration logic and no divergent procedure copy.

## Coordinator Matrix

| Coordinator | Entry point | Automatic wake | Worker kinds |
| --- | --- | --- | --- |
| Kilo | Kilo plugin and `/implement-task` | Exact originating Herdr pane | Kilo, Claude, Codex |
| Claude Code | Local `engineering-workflow` stdio MCP server | Exact originating Herdr pane | Kilo, Claude, Codex |
| Codex | Local `engineering-workflow` stdio MCP server | Exact originating Herdr pane | Kilo, Claude, Codex |

The public operations are exactly:

1. `workflow_start`: start all three review roles after a stable implementation checkpoint.
2. `workflow_status`: inspect live or durable state and collected reports.
3. `workflow_send`: send a targeted instruction to an existing worker.
4. `workflow_stop`: terminate one worker when explicitly requested.
5. `workflow_retry`: replace a failed, stopped, stale, or unsatisfactory worker.

`workflow_start` accepts an optional `workerAgents` map with the fixed keys
`tests`, `code-review`, and `readability`. Omitted keys default to `kilo`.
The selected worker kind, skill snapshot, capability profile, and enforcement
are persisted with the run. Test workers can write generated artifacts;
review workers use Claude plan mode or Codex read-only mode where supported.
Kilo review enforcement is prompt/checkpoint based and does not guarantee
that Kilo cannot write files.

## Requirements

Every coordinator and worker process must be launched in a Herdr workspace.
Install and authenticate the host tools separately; this repository does not
install provider credentials or broaden permissions.

Required for every installation and coordinator:

- Git
- Node.js 22.22.2 or newer and npm
- the `herdr` CLI
- a Kilo, Claude Code, or Codex client for the selected coordinator
- local stdio MCP support for Claude Code or Codex coordinators

Additional harness requirements:

- Kilo: Kilo Code with `@kilocode/plugin` 7.4.20 compatibility and the `kilo` command on PATH
- Claude: the `claude` command, installable with `npm install -g @anthropic-ai/claude-code`
- Codex: the `codex` command, installable with `npm install -g @openai/codex`
- Claude or Codex workers: a current Herdr integration

Install the non-Kilo Herdr integrations explicitly when needed:

```text
herdr integration install claude
herdr integration install codex
```

The installer preflights selected CLIs, Node, npm and checkout dependencies,
Herdr, and the selected Claude/Codex integrations before mutating a
destination. Use `--skip-dependencies` or `-SkipDependencies` only when the
checkout dependencies are already available. A project install may also
require the selected harness to trust the project before its MCP or skill
configuration is loaded.

## Workflow Runtime

Start `/implement-task` or `workflow_start` only after implementation files
are at a stable checkpoint. Reports and notifications are persisted under the
target project's `.workflow/runs/` directory.

The active host owns in-memory supervision. Closing Kilo, Claude Code, or
Codex pauses watches without losing run state or the durable notification
outbox. Restart recovery is allowed only for the same coordinator kind, exact
Herdr pane, workspace, and canonical project root. A Kilo session ID is an
additional recovery constraint when present.

Wakes are sent through `herdr agent prompt` to the exact recorded pane after
Herdr validates its pane ID, workspace, project path, and coordinator kind.
They are generated for blocked, failed, stale, and completed review states.
If the pane is missing or validation/delivery fails, the notification remains
pending and its delivery error is visible through status. It is never redirected
to the newest agent or another pane with a similar cwd. Delivery retries are
bounded.

A new pane may inspect a known run by passing its `runId` to
`workflow_status`, but it cannot claim the run, start its watches, mutate it,
or receive its wakes. There is no daemon, remote MCP transport, or supervision
while every coordinator process is closed.

The MCP adapter obtains the project from the trusted host. It uses
`CLAUDE_PROJECT_DIR` when provided and otherwise resolves the MCP cwd to its
containing Git root; both must resolve to the same repository. The tool caller
cannot supply an arbitrary project path. MCP startup also requires inherited
`HERDR_ENV=1`, `HERDR_SOCKET_PATH`, `HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`, and
`WORKFLOW_COORDINATOR_KIND` (`kilo`, `claude`, or `codex`).

## Install Selection

The installers accept `kilo`, `claude`, `codex`, or `all`. Selections are
opt-in and repeatable. Omitting `--harness` or `-Harness` preserves the
historical Kilo-only default. `all` expands to Kilo, Claude, and Codex.
Unix accepts `global` as a compatibility alias for user scope; Windows accepts
`Global` as the same alias.

Installation runs `npm ci` and `npm test` by default. Add the documented skip
flags only for an already prepared checkout. `--update` or `-Update` repeats
the same preflight and ownership transaction for an existing installation.

### Windows User Scope

Run these from the checkout. Each command is an independently supported,
copy-pastable harness selection:

```powershell
.\scripts\install.ps1 -Scope User -Harness kilo
.\scripts\install.ps1 -Scope User -Harness claude
.\scripts\install.ps1 -Scope User -Harness codex
.\scripts\install.ps1 -Scope User -Harness all
```

### Windows Project Scope

```powershell
$project = 'C:\Work\Project'
.\scripts\install.ps1 -Scope Project -ProjectPath $project -Harness kilo
.\scripts\install.ps1 -Scope Project -ProjectPath $project -Harness claude
.\scripts\install.ps1 -Scope Project -ProjectPath $project -Harness codex
.\scripts\install.ps1 -Scope Project -ProjectPath $project -Harness all
```

### Unix User Scope

Run these from the checkout. `--scope global` may be used instead of
`--scope user`:

```bash
sh ./scripts/install.sh --scope user --harness kilo
sh ./scripts/install.sh --scope user --harness claude
sh ./scripts/install.sh --scope user --harness codex
sh ./scripts/install.sh --scope user --harness all
```

The user Kilo registration is added to the selected shell profile, or to the
profile passed with `--profile PATH`. Start a new shell after installation.

### Unix Project Scope

```bash
project=/work/project
sh ./scripts/install.sh --scope project --project "$project" --harness kilo
sh ./scripts/install.sh --scope project --project "$project" --harness claude
sh ./scripts/install.sh --scope project --project "$project" --harness codex
sh ./scripts/install.sh --scope project --project "$project" --harness all
```

Project installs do not set `KILO_CONFIG_DIR` or modify a shell profile. They
can be launched from a project subdirectory: the copied MCP bootstrap walks up
to the project toolkit. The installer still receives the project root through
`-ProjectPath` or `--project`.

### Update And Force

Updates are ordinary ownership-aware transactions:

#### Windows Update

```powershell
.\scripts\install.ps1 -Scope User -Harness kilo -Update
.\scripts\install.ps1 -Scope User -Harness claude -Update
.\scripts\install.ps1 -Scope User -Harness codex -Update
.\scripts\install.ps1 -Scope User -Harness all -Update
.\scripts\install.ps1 -Scope Project -ProjectPath C:\Work\Project -Harness kilo -Update
.\scripts\install.ps1 -Scope Project -ProjectPath C:\Work\Project -Harness claude -Update
.\scripts\install.ps1 -Scope Project -ProjectPath C:\Work\Project -Harness codex -Update
.\scripts\install.ps1 -Scope Project -ProjectPath C:\Work\Project -Harness all -Update
```

The same supported selections can explicitly force a safe displaced-value
replacement:

#### Windows Force Replacement

```powershell
.\scripts\install.ps1 -Scope User -Harness kilo -Update -Force
.\scripts\install.ps1 -Scope User -Harness claude -Update -Force
.\scripts\install.ps1 -Scope User -Harness codex -Update -Force
.\scripts\install.ps1 -Scope User -Harness all -Update -Force
.\scripts\install.ps1 -Scope Project -ProjectPath C:\Work\Project -Harness kilo -Update -Force
.\scripts\install.ps1 -Scope Project -ProjectPath C:\Work\Project -Harness claude -Update -Force
.\scripts\install.ps1 -Scope Project -ProjectPath C:\Work\Project -Harness codex -Update -Force
.\scripts\install.ps1 -Scope Project -ProjectPath C:\Work\Project -Harness all -Update -Force
```

#### Unix Update

```bash
sh ./scripts/install.sh --scope user --harness kilo --update
sh ./scripts/install.sh --scope user --harness claude --update
sh ./scripts/install.sh --scope user --harness codex --update
sh ./scripts/install.sh --scope user --harness all --update
sh ./scripts/install.sh --scope project --project /work/project --harness kilo --update
sh ./scripts/install.sh --scope project --project /work/project --harness claude --update
sh ./scripts/install.sh --scope project --project /work/project --harness codex --update
sh ./scripts/install.sh --scope project --project /work/project --harness all --update
```

#### Unix Force Replacement

```bash
sh ./scripts/install.sh --scope user --harness kilo --update --force
sh ./scripts/install.sh --scope user --harness claude --update --force
sh ./scripts/install.sh --scope user --harness codex --update --force
sh ./scripts/install.sh --scope user --harness all --update --force
sh ./scripts/install.sh --scope project --project /work/project --harness kilo --update --force
sh ./scripts/install.sh --scope project --project /work/project --harness claude --update --force
sh ./scripts/install.sh --scope project --project /work/project --harness codex --update --force
sh ./scripts/install.sh --scope project --project /work/project --harness all --update --force
```

`--force` and `-Force` are explicit. They do not make arbitrary payload or
dependency conflicts safe. Force replacement is allowed only when the
transaction can retain exact displaced configuration for restoration.

## Payload Locations

User scope is checkout-backed. Kilo registers the checkout through
`KILO_CONFIG_DIR` on Windows or a marked Unix profile block. Claude and Codex
registrations point to the checkout's `mcp/server.ts`; no second runtime copy
is created. User payloads and registration targets are:

| Harness | MCP/config registration | Skills |
| --- | --- | --- |
| Kilo | `KILO_CONFIG_DIR` points to the checkout | Skills are available from the checkout |
| Claude | `~/.claude.json`, key `mcpServers.engineering-workflow` | `~/.claude/skills/` |
| Codex | `~/.codex/config.toml`, table `mcp_servers.engineering-workflow` | `~/.agents/skills/` |

Project scope is self-contained under the project and does not depend on the
checkout after installation:

- shared runtime, MCP server, launcher, skills, package metadata, and copied dependencies: `.agents/toolkits/kilo-herdr-engineering-workflow/`
- Kilo thin plugin and command: `.kilo/plugin/` and `.kilo/command/`
- Claude skills and project MCP registration: `.claude/skills/` and `.mcp.json`
- Codex skills and project MCP registration: `.agents/skills/` and `.codex/config.toml`

The project MCP registration uses a bootstrap that locates the copied toolkit
from the current directory or any descendant. Project-local skills take
precedence over user skills according to the harness's normal discovery rules;
the project Kilo payload must not be combined with an active global Kilo copy.

Ownership metadata is separate from workflow history. User manifests live at
`~/.config/kilo-herdr-engineering-workflow/ownership.json`; project manifests
live at `.agents/toolkits/kilo-herdr-engineering-workflow/ownership.json`.
Project displaced configuration values are stored in a private restore-data
root outside the project. Never put that restore data inside the project.

## Conflicts And Uninstall Safety

All selected harnesses are preflighted before any destination is mutated. The
transaction refuses invalid JSON/TOML, missing prerequisites, unsafe paths,
symlinks, duplicate Kilo discovery, and unowned payload conflicts. Claude
merges only `mcpServers.engineering-workflow`; Codex edits only the named
`mcp_servers.engineering-workflow` table while preserving unrelated keys,
comments, and content.

The ownership manifest records harnesses, copied-file hashes, registrations,
inserted profile blocks, dependencies, and displaced values. On update or
uninstall:

- unchanged owned files and registrations may be replaced or removed;
- modified owned files, dependencies, registrations, and concurrent edits are retained with warnings;
- shared files remain when another selected installation still owns them;
- an unchanged installed registration can restore its exact displaced value;
- missing or unsafe restore data is retained and reported;
- a moved checkout or Node executable requires reinstalling the checkout-backed registration;
- the Phase 1 TSV project manifest is refused rather than guessed into the new contract;
- `.workflow` history and unrelated user or project harness configuration are never removed.

### Windows User Uninstall

```powershell
.\scripts\uninstall.ps1 -Scope User -Harness kilo
.\scripts\uninstall.ps1 -Scope User -Harness claude
.\scripts\uninstall.ps1 -Scope User -Harness codex
.\scripts\uninstall.ps1 -Scope User -Harness all
```

### Windows Project Uninstall

```powershell
$project = 'C:\Work\Project'
.\scripts\uninstall.ps1 -Scope Project -ProjectPath $project -Harness kilo
.\scripts\uninstall.ps1 -Scope Project -ProjectPath $project -Harness claude
.\scripts\uninstall.ps1 -Scope Project -ProjectPath $project -Harness codex
.\scripts\uninstall.ps1 -Scope Project -ProjectPath $project -Harness all
```

### Unix User Uninstall

```bash
sh ./scripts/uninstall.sh --scope user --harness kilo
sh ./scripts/uninstall.sh --scope user --harness claude
sh ./scripts/uninstall.sh --scope user --harness codex
sh ./scripts/uninstall.sh --scope user --harness all
```

### Unix Project Uninstall

```bash
project=/work/project
sh ./scripts/uninstall.sh --scope project --project "$project" --harness kilo
sh ./scripts/uninstall.sh --scope project --project "$project" --harness claude
sh ./scripts/uninstall.sh --scope project --project "$project" --harness codex
sh ./scripts/uninstall.sh --scope project --project "$project" --harness all
```

Omitting the harness preserves the Kilo-only uninstall default. Use the same
scope, project path, and private restore root used for installation when those
values were customized.

## Existing Kilo Configuration

Global Kilo installation registers this checkout and does not copy over
`~/.config/kilo`, `~/.kilo`, provider credentials, or project `.kilo` content.
Project installation writes only its owned `.kilo` payload after preflight.
Resolve an existing `KILO_CONFIG_DIR` pointing elsewhere or an existing
workflow plugin under supported Kilo roots before installing Kilo; otherwise
the installer refuses duplicate tool discovery. `--force` is not a substitute
for deciding which Kilo installation should remain active.

## Update The Checkout

```bash
git pull
npm ci
npm test
```

User registrations are checkout-backed, so updating the checkout is enough
when its path has not changed. If the checkout moves, reinstall the affected
user harnesses so the stored MCP or `KILO_CONFIG_DIR` value points to the new
absolute path. Project installations are self-contained and should be updated
with the project-scoped installer.

## Validation

`npm test` runs the runtime, MCP, adapter, ownership, transaction, and
installer suites. `npm run test:installer` runs the focused Windows/Unix
wrapper matrix. The matrix uses temporary checkout, home, project, profile,
environment, and restore roots and covers Kilo, Claude, Codex, and `all` for
both scopes, repeated update, clean uninstall, conflicts, force replacement,
modified content, malformed configuration, rollback, displaced restoration,
project subdirectories, concurrent edits, symlinks, and paths with spaces.

Automated tests use fake preflight and Herdr backends. They do not install or
invoke real Kilo, Claude, Codex, or Herdr integrations. A real coordinator
smoke test must therefore be run manually from each available coordinator in
Herdr; no real-harness result is claimed by this checkout unless recorded
separately.
