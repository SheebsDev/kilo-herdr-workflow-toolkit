---
name: task-planning
description: Decompose an existing implementation plan markdown into small, ordered Task Cards with clear scope, dependencies, acceptance criteria, and verification requirements. Use only in Kilo Code/Build mode as we will be writing new task cards. Do Not use during Plan mode.
---

# Task Planning

You are extending an existing implementation plan into a sequence of small, executable Task Cards.

Do not redesign the feature unless decomposition exposes a material problem in the plan.

# Primary Goal

Convert the implementation plan into work units that an implementation agent can execute independently and review confidently.

Each Task Card should answer:

* What exactly should be built?
* Why does this task exist?
* What is in scope?
* What is explicitly not in scope?
* What does this task depend on?
* How do we know it is complete?
* How should it be verified?

A Task Card should be small enough that its implementation and resulting diff are easy for a human to understand and review.

# Preserve the Plan

The implementation plan is read-only source context and must not be modified, appended to, renamed, or deleted.

Task Cards are separate files derived from that plan. Do not place Task Cards inside the source plan.

Derive the feature folder from the source plan filename by removing its `.md` extension and any leading numeric timestamp plus hyphen. For example:

`.kilo/plans/1786849990968-phase-1-multi-agent-workers.md` becomes `.kilo/plans/phase-1-multi-agent-workers/`.

Create one file per Task Card in that folder, named `TASK-XXX-short-action-title.md`.

Do not duplicate the entire plan inside every Task Card. Cards should contain enough context to be executable while referring back to the source plan for broader architectural reasoning.

# When to Create Task Cards

Only create task cards off of an existing plan markdown.

When defining more granular details outside of the plan markdown, create questions that will need be answered upon task execution.

Do no pause the cards creation to ask now.

Here are a few examples of what to be looking for, but do not limit yourself to only these:

* an unresolved architecture decision
* an unclear ownership boundary
* a missing dependency
* conflicting requirements
* a Task Card that cannot be scoped cleanly

# Task Size

Prefer small, logically grouped units for tasks.

A good Task Card usually represents one meaningful engineering change such as, but not limited to:

* introducing one domain concept
* adding one API or component
* implementing one behavior
* wiring one integration point
* migrating one bounded piece of existing behavior
* adding focused verification for one behavior
* performing one necessary cleanup that enables subsequent work

# Sizing Heuristic

A Task Card should generally be:

* understandable without a long explanation
* implementable without making major new design decisions
* reviewable as one coherent diff
* independently verifiable where practical

Prefer more small cards over a few large cards when the smaller boundaries are meaningful.

Do not split work merely to create more cards.

Avoid artificial tasks that require multiple cards to be understood together when one coherent change would be simpler.

# One Primary Responsibility

Each Task Card should have one primary objective.

If a card contains several unrelated verbs such as:

* create
* migrate
* redesign
* optimize
* add UI
* update persistence

it is probably too broad.

Split unrelated responsibilities.

Related implementation steps may remain together when separating them would create incomplete or unusable intermediate states.

# Dependencies

Explicitly identify dependencies between cards.

Use Task Card identifiers such as:

* TASK-001
* TASK-002
* TASK-003

Prefer a dependency graph that allows independent work where possible.

Foundational work should attempt to appear before its dependent work.

Do not force this sequence when the feature naturally requires another order

Avoid unnecessary serial dependencies.

For example:

TASK-001
shared domain model

TASK-002
persistence implementation
depends on TASK-001

TASK-003
UI implementation
depends on TASK-001

TASK-004
integration
depends on TASK-002 and TASK-003

This is preferable to forcing every task into a strictly linear chain when the architecture does not require it.

# Vertical Slices vs Layer Tasks

Prefer Task Cards that produce meaningful behavior rather than splitting work purely by technical layer.

For example, avoid automatically creating:

* database task
* service task
* API task
* UI task

when a small vertical behavior can be implemented and verified coherently.

However, layer-oriented cards are appropriate when:

* the layer introduces a reusable foundation
* multiple later tasks depend on it
* ownership boundaries make the separation natural
* separate engineers could work on the layers safely

Choose boundaries based on architecture and reviewability, not a fixed template.

# Task Card Format

Use this structure for each card:

## TASK-XXX — Short Action-Oriented Title

### Objective

State the single outcome this task must produce.

Describe the result, not the implementation process.

### Unanswered Decision

Any architectural or behavior decisions that have not been answered by the plan markdown that need to be addressed.

### Context

Provide only the context needed to understand this task.

Include relevant architectural decisions or assumptions from the larger plan when necessary.

Avoid repeating the complete plan.

### Scope

List the behavior or implementation responsibilities included in this task.

Be concrete.

### Out of Scope

Explicitly identify nearby work that this card does not own.

Use this to prevent scope creep and accidental implementation of later cards.

### Dependencies

List required predecessor Task Cards.

Write `None` when the task is independent.

### Implementation Guidance

Describe important implementation direction established by the plan.

Include items such as:

* existing abstractions to use
* architectural boundaries
* ownership rules
* important framework patterns
* required compatibility constraints
* relevant files or modules when reasonably known

Do not turn this section into line-by-line implementation instructions.

The implementation agent should retain normal engineering judgment.

### Acceptance Criteria

Write observable conditions that determine whether the task is complete.

Acceptance criteria should be:

* specific
* testable or otherwise verifiable
* implementation-independent where practical

Prefer:

* "Whitespace-only display names are rejected."

over:

* "Add a validation check in UserService."

Include negative or failure behavior when it materially matters.

### Verification

Describe the important evidence expected for completion.

Examples:

* focused unit tests
* integration test
* successful build
* UI interaction verification
* existing regression suite
* manual verification when automation is unavailable

Do not prescribe exact test code unless required by the plan.

### Notes

Optional.

Use only for information that does not naturally belong elsewhere.

Do not create this section when there is nothing useful to add.

# Acceptance Criteria Quality

Acceptance criteria are the contract between planning, implementation, and review.

They should describe behavior rather than vague quality goals.

Avoid:

* works correctly
* handles edge cases
* follows best practices
* has good performance
* is clean and maintainable

Instead state the relevant observable requirement.

For example:

Bad:

"Handles invalid input correctly."

Better:

"An empty or whitespace-only display name is rejected without creating a user."

Bad:

"Does not hurt performance."

Better:

"The new lookup does not perform a database query for each item in the returned collection."

# Implementation Guidance vs Acceptance Criteria

Keep these separate.

Implementation Guidance answers:

"How should this fit into the system?"

Acceptance Criteria answers:

"What must be true when the task is finished?"

Do not make implementation details acceptance criteria unless the architecture specifically requires them.

# Verification Requirements

Every card should contain enough verification guidance that the independent test-verification worker can determine what evidence matters.

Do not require a new automated test for every card.

Require meaningful verification based on risk.

Simple structural changes may only need:

* build
* existing tests

Behavior changes generally need focused behavioral verification.

Bug fixes should usually include regression verification when practical.

Complex state, concurrency, persistence, networking, or lifecycle changes generally warrant stronger verification.

# Human Reviewability

Task decomposition should make code review easier.

Prefer cards whose resulting diff tells one understandable story.

Avoid combining:

* unrelated cleanup
* broad renames
* architecture changes
* feature behavior
* formatting churn

inside the same Task Card unless they are genuinely inseparable.

If a prerequisite cleanup is necessary, create a separate Task Card for it.

# Avoid Premature Refactoring

Do not create refactor cards simply because surrounding code could be improved.

Create refactoring work when it is:

* necessary for the planned feature
* necessary to preserve architecture
* required to make subsequent tasks reasonably implementable
* explicitly requested

Do not expand the plan into a general cleanup effort.

# Files and Code Areas

When repository exploration makes likely files or modules clear, mention them in Implementation Guidance.

Treat these as orientation, not rigid file contracts.

The implementation agent may discover that another file needs to change.

Do not create speculative file lists merely to make the card look complete.

# Parallel Work

Identify Task Cards that can safely execute independently.

When useful, add:

### Can Run In Parallel With

* TASK-XXX
* TASK-YYY

Only include this when parallel execution is genuinely safe.

Consider:

* shared files
* shared APIs
* unresolved contracts
* migration ordering
* likely merge conflicts

Do not claim tasks are parallel merely because their objectives differ.

# Task Card Count

There is no target number of Task Cards.

Create as many as the feature naturally requires.

A small feature may need:

* 1–3 cards

A moderate feature may need:

* 4–8 cards

A large feature may need more.

Do not inflate the count to fit these examples.

If a card becomes too large, split it.

If two cards are trivial and tightly coupled, combine them.

# Output Verification

Before finalizing, verify that every Task Card is a separate file in the derived feature folder and that the source plan has not changed.

# Reviewing the Decomposition

Before finalizing Task Cards, verify:

* every important part of the plan belongs to a card
* no major implementation work exists only implicitly
* acceptance criteria cover the intended behavior
* dependencies are accurate
* cards are reasonably small
* cards do not overlap unnecessarily
* excluded scope has not quietly entered the plan
* cards can be reviewed independently where practical
* later cards receive the prerequisites they need

Also check for gaps between cards.

The set of Task Cards should collectively implement the plan.

# Do Not Implement

This skill is for planning and decomposition.

Do not:

* modify production code
* begin implementing Task Cards
* run the implementation review workflow
* change architecture merely to simplify decomposition
* silently resolve major product ambiguity without surfacing it

# Completion Principle

A good Task Card removes implementation ambiguity without removing implementation judgment.

The plan determines the architecture.

The Task Card determines the scope and completion contract.

The Code agent determines the detailed implementation.
