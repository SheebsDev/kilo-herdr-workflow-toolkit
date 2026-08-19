---
name: implement-task
description: Implement a Task Card as the active coordinator and coordinate the five-operation engineering verification workflow from Kilo, Claude Code, or Codex.
---

# Implement Task

Implement the requested Task Card, feature, or code change using the normal
capabilities of the active coordinator harness.

You are the implementation owner and coordinator for this workflow. Do not
replace normal code behavior with a simplified implementation process. Use
normal repository exploration, reasoning, editing, and engineering practices.

## 1. Establish the Task

Identify the Task Card or implementation request from the user's request and
conversation context.

When a Task Card is provided, treat it as the authoritative definition of the
objective, acceptance criteria, constraints, and explicitly excluded scope.
Read relevant project instructions such as `AGENTS.md`. Inspect enough of the
existing implementation to understand the architecture, conventions, and
affected behavior before making changes. Do not silently expand the requested
scope. If the Task Card is materially incorrect or cannot reasonably be
completed as written, report the conflict instead of guessing.

Task Cards use a YAML metadata block with `task_id`, `status`, and `depends_on`.
Before implementation, confirm every dependency is `completed`. If a
dependency is not complete, do not silently proceed: leave the requested card
`blocked` and record the reason. Set the requested card to `in_progress` when
work begins. Set it to `blocked` when work cannot proceed, or to `completed`
only after the completion criteria below are satisfied. Do not use a Git commit
as a substitute for updating the card status.

## 2. Implement

Implement the requested change using the active harness's normal code agent.
Prefer the smallest coherent implementation, existing project patterns, clear
domain-oriented code, straightforward control flow, and changes limited to the
requested scope.

Do not start review workers while the implementation is still changing. Run
useful immediate development checks as needed, but remember that they do not
replace independent verification.

## 3. Reach a Stable Checkpoint

Before starting independent verification:

1. Finish the intended implementation.
2. Inspect the complete changed-file set and diff.
3. Resolve obvious implementation errors already identified.
4. Ensure files are no longer actively being modified.
5. Confirm the working tree represents one coherent implementation checkpoint.

A Git commit is not required. Review workers inspect the current working tree.

## 4. Start Independent Verification

Once the implementation is stable, use the active harness's `workflow_start`
operation from a coordinator session running inside Herdr. The five public
workflow operations are exactly:

- `workflow_start`
- `workflow_status`
- `workflow_send`
- `workflow_stop`
- `workflow_retry`

Kilo, Claude Code, and Codex coordinators must use these equivalent operations;
do not create harness-specific orchestration behavior or duplicate this
procedure. Provide a concise task identifier or description and, when known,
the project-relative Task Card path.

If the coordinator session is not running inside Herdr, report that parallel
verification cannot be launched. Do not silently replace independent workers
with self-review.

Retain the returned `runId` and pass that exact ID to later workflow control
operations. Never use a newer or guessed run ID. The workflow starts
independent workers for test verification, code review, and human readability
review. Review-only workers must not modify the implementation.

After `workflow_start` returns, do not poll `workflow_status`, run sleep
commands, or keep the turn open merely to wait. The originating coordinator is
woken when a worker blocks, fails, becomes stale, or all reports complete.

## 5. Durable Wakes and Active-Host Lifetime

Wake delivery targets the exact Herdr pane recorded for the originating
coordinator. A notification is not redirected to the most recent agent or to
another pane based on workspace or cwd similarity. Notifications are persisted
before delivery and are marked delivered only after a successful prompt. If
delivery fails or the pane no longer exists, leave the notification pending and
expose that state through status; do not guess a replacement.

Supervision is process-local. Closing the active Kilo, Claude Code, or Codex
host pauses in-memory supervision without losing durable run or outbox state.
Only a restart of the same coordinator kind in the same Herdr pane and
canonical project can resume supervision and pending notification delivery.
A new pane may inspect an old run by ID, but must not silently claim it, start
its watches, or receive its wakes. A Kilo session identifier, when present, is
an additional same-host recovery constraint.

## 6. Remain the Coordinator

When an engineering workflow wake arrives, call `workflow_status` with the
wake's exact `runId` and collect the durable reports and current state. Continue
the implementation and review process without waiting for another user
instruction.

Use the workflow operations to inspect worker state, answer status questions,
request focused output, redirect or narrow an investigation, stop a worker when
the user explicitly requests it, or retry a failed, stuck, terminated, or
stale worker. Do not create duplicate workers when an existing worker can be
redirected or retried. Completed reports remain available after their Herdr
panes close; blocked or failed workers remain available for inspection.

## 7. Evaluate Findings

Evaluate reports against the Task Card, architecture, repository conventions,
correctness, maintainability, simplicity, and readability. The implementation
agent owns the final engineering decision.

Treat `BLOCKING` findings as issues that normally must be resolved before
completion. Treat `NON-BLOCKING` findings as recommendations that may be
accepted, deferred, or rejected. If a blocking finding is rejected because the
reviewer is incorrect, record the reason rather than changing correct code
merely to satisfy the report.

The reviewer skills remain the authoritative worker methodology sources:

- `skills/test-verification/SKILL.md`
- `skills/code-review/SKILL.md`
- `skills/readability-review/SKILL.md`

They remain independently invocable and may be injected into worker prompts by
the workflow. Do not duplicate their procedures in this skill or in harness
entrypoints.

## 8. Fix Accepted Findings

Fix accepted blocking findings using the active code agent. Review workers do
not modify the implementation.

After a fix, reach another stable checkpoint, determine which verification
areas were affected, and retry only the affected workers with the original
workflow run. Logic changes generally require test verification and code
review again. Significant restructuring may require all three reviews. A
localized readability fix generally requires only readability review. A test
environment failure without code changes generally requires only test
verification.

Do not start a polling loop after a retry. Wait for the next durable wake.

## 9. Complete the Task

Consider the implementation complete only when the Task Card acceptance
criteria are satisfied, relevant verification passes, no accepted blocking code
or readability findings remain, and important unverified areas are resolved or
explicitly accepted by the user.

Update the Task Card metadata to `completed` when complete. If implementation
or verification is incomplete, leave it `in_progress` or change it to
`blocked`, with a concise explanation in the card's Notes section.

Report the result concisely under these headings:

## Implementation

What changed.

## Verification

Meaningful tests, builds, checks, or other verification that passed.

## Review

What independent reviewers found and which blocking issues were corrected.

## Remaining Observations

Intentionally deferred non-blocking findings or known unverified areas.

Keep the report concise; do not include a lengthy workflow transcript.
