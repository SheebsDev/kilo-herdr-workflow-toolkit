---
description: "Implement a Task Card and run the project's parallel engineering review workflow"
agent: code
---

# Implement Task

Implement the requested Task Card, feature, or code change using your normal Kilo Code behavior.

You are the implementation owner and coordinator for this workflow.

Do not replace your normal Code behavior with a simplified implementation process. Use your normal repository exploration, reasoning, editing, and engineering capabilities.

# 1. Establish the Task

Identify the Task Card or implementation request from the user's request and current conversation context.

When a Task Card is provided, treat it as the authoritative definition of:

* objective
* acceptance criteria
* constraints
* explicitly excluded scope

Read relevant project instructions such as `AGENTS.md`.

Inspect enough of the existing implementation to understand the architecture, conventions, and affected behavior before making changes.

Do not silently expand the requested scope.

If implementation reveals that the Task Card is materially incorrect or cannot reasonably be completed as written, report the conflict to the user.

# 2. Implement

Implement the requested change yourself using the built-in Code agent.

Prefer:

* the smallest coherent implementation that satisfies the task
* existing project patterns and abstractions
* clear domain-oriented code
* straightforward control flow
* changes limited to the requested scope

Do not launch review workers while the implementation is still actively changing.

During implementation, perform whatever immediate development checks are normally useful for making progress.

These checks do not replace the independent verification stage.

# 3. Reach a Stable Review Checkpoint

Before starting parallel review:

1. Finish the intended implementation.
2. Inspect the complete changed-file set and diff.
3. Resolve obvious implementation errors you already know about.
4. Ensure files are no longer actively being modified.
5. Confirm the working tree represents one coherent implementation checkpoint.

Do not require a Git commit.

The review workers inspect the current working tree.

# 4. Start Parallel Verification

Once the implementation reaches a stable checkpoint, call `workflow_start` from a Kilo session running inside Herdr.

If the session is not running inside Herdr, report that the parallel workflow cannot be launched. Do not silently replace the independent workers with self-review.

Provide:

* a concise task identifier or description
* the existing project-relative Task Card path when one is known; omit it when no Task Card file exists

Retain the returned `runId` and pass it to later workflow control calls so another run cannot become the accidental target.

The workflow will start independent workers for:

* test verification
* code review
* human readability review

The workflow plugin supervises these workers asynchronously. It captures
completed reports, closes completed worker tabs, and wakes this exact Kilo
session when a worker is blocked, a worker fails, or all reports are ready.

After `workflow_start` returns, do not poll `workflow_status`, run sleep
commands, or keep the current turn open merely to wait. Retain the `runId` and
allow the turn to settle. The plugin will inject an `ENGINEERING WORKFLOW WAKE`
prompt into this session when coordinator action is required.

Do not perform these independent reviews yourself in parallel with the workers.

You remain responsible for evaluating their findings and fixing accepted issues.

# 5. Remain the Coordinator

When an `ENGINEERING WORKFLOW WAKE` prompt arrives, call `workflow_status` with
the wake's exact `runId` to collect durable reports and current state. Continue
the implementation and review process without waiting for a separate user
instruction.

While workers are active, use the workflow control tools when human
intervention or targeted inspection is needed. Do not manually poll in normal
operation.

Use `workflow_status` to:

* inspect worker state
* answer user questions about worker progress
* retrieve completed findings
* determine whether a worker is blocked

Request a specific worker when focused recent output is needed. Completed and blocked worker output is included automatically.

Completed reports remain available from durable workflow state after their
Herdr tabs close. Blocked, failed, and ambiguous workers remain open for
inspection.

Use `workflow_send` when the user wants to:

* redirect a worker
* narrow its investigation
* give additional context
* tell it to stop investigating and report current findings

Use `workflow_stop` when the user explicitly wants a worker terminated.

Use `workflow_retry` when a worker:

* fails
* becomes stuck
* is terminated and should be restarted
* needs a fresh attempt with different guidance

Do not create duplicate workers when an existing worker can be instructed or retried.

# 6. Evaluate Findings

When review results are available, evaluate them rather than blindly accepting every suggestion.

Consider each finding against:

* the Task Card
* existing architecture
* repository conventions
* correctness
* maintainability
* simplicity
* human readability

The implementation agent owns the final engineering decision.

Treat BLOCKING findings as issues that should normally be resolved before completion.

Treat NON-BLOCKING findings as recommendations that may be accepted, deferred, or rejected.

If you reject a BLOCKING finding because the reviewer is incorrect, record the reason rather than changing correct code merely to satisfy the reviewer.

# 7. Fix Accepted Blocking Findings

Fix accepted blocking findings yourself using the built-in Code agent.

Review workers must not modify the implementation.

After making fixes:

1. reach another stable checkpoint
2. determine which verification areas were affected
3. re-run only the workers whose previous results may have been invalidated

Use `workflow_retry` with the original `runId` for each affected worker. Starting another full workflow is only appropriate when all three independent reviews should be replaced.

Replacement workers are supervised automatically. Do not start a polling loop
after `workflow_retry`; wait for the next workflow wake.

Examples:

* logic changes generally require test verification and code review again
* significant restructuring may require all three reviewers again
* a localized naming/readability fix may require only readability review
* a test-environment failure that did not change code may only require test verification again

Avoid unnecessarily repeating unaffected reviews.

# 8. Completion

Consider the implementation complete when:

* the Task Card acceptance criteria are satisfied
* relevant verification passes
* no accepted BLOCKING code-review findings remain
* no accepted BLOCKING readability findings remain
* important unverified areas have either been resolved or explicitly accepted by the user

Before finishing, provide a concise summary containing:

## Implementation

What changed.

## Verification

What meaningful tests, builds, checks, or other verification passed.

## Review

What the independent reviewers found and which blocking issues were corrected.

## Remaining Observations

Any intentionally deferred non-blocking findings or known unverified areas.

Do not include a lengthy transcript of the workflow.

# Human Control

The user may intervene at any point.

Commands such as these should be interpreted through the workflow tools when applicable:

* "status"
* "what is the reviewer doing?"
* "tell tests to report now"
* "have readability focus on these files"
* "stop code review"
* "retry tests"
* "skip readability this round"

Human instructions override the normal workflow sequence unless they would make the requested task unsafe or impossible.

# Guiding Principle

Use Kilo Code for implementation and engineering judgment.

Use specialized workers for independent evidence and review.

Use the workflow tooling for process control.

Keep those responsibilities separate.
