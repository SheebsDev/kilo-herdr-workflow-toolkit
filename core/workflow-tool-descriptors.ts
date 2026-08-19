import { BUILT_IN_ROLE_ORDER } from "./model.ts";

export const WORKFLOW_TOOL_DESCRIPTORS = {
  workflow_start: {
    description: `
Start the project's parallel engineering verification workflow.

Use this AFTER implementing a Task Card, feature, bug fix, or other code
change and reaching a stable implementation checkpoint. The optional
workerAgents map selects an agent per role; omitted roles default to Kilo:

- test verification
- code review
- human readability review

The project root, Herdr workspace, pane, and coordinator identity come from
the active host and cannot be supplied through this tool.
`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["task"],
      properties: {
        task: {
          type: "string",
          minLength: 1,
          maxLength: 8_000,
          description: "Task identifier or short description being reviewed.",
        },
        taskCardPath: {
          type: "string",
          maxLength: 500,
          description:
            "Optional project-relative path to the Task Card being implemented.",
        },
        workerAgents: {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(
            BUILT_IN_ROLE_ORDER.map((role) => [role, {
              type: "string",
              enum: ["kilo", "claude", "codex"],
            }]),
          ),
          description:
            "Optional per-role agent selection. Omitted roles default to Kilo.",
        },
      },
    },
  },
  workflow_status: {
    description: `
Inspect the live or durably captured state of the current engineering workflow.

Use this when the user asks for status, asks what a worker is doing,
or when you need to collect completed review results.

If no run ID is supplied, the most recently created workflow run is used.
`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: {
          type: "string",
          description: "Workflow run ID. Defaults to the latest run.",
        },
        worker: {
          type: "string",
          enum: [...BUILT_IN_ROLE_ORDER],
          description: "Optional worker: tests, code-review, or readability.",
        },
        includeOutput: {
          type: "boolean",
          description:
            "Include recent terminal output. Defaults to true for a specifically requested worker and completed/blocked workers.",
        },
      },
    },
  },
  workflow_send: {
    description: `
Send a targeted instruction to an existing workflow worker.

Use this to redirect a worker, narrow its investigation, answer a question,
or tell it to stop further investigation and report its current findings.

This sends a prompt to the existing worker session; it does not create a new
one.
`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["worker", "message"],
      properties: {
        runId: {
          type: "string",
          description: "Workflow run ID. Defaults to the latest run.",
        },
        worker: {
          type: "string",
          enum: [...BUILT_IN_ROLE_ORDER],
          description: "Worker: tests, code-review, or readability.",
        },
        message: {
          type: "string",
          minLength: 1,
          maxLength: 8_000,
          description: "Instruction to send to the worker.",
        },
      },
    },
  },
  workflow_stop: {
    description: `
Terminate one workflow worker.

Use this when the user explicitly wants a worker stopped or killed.
The worker's Herdr tab is closed, terminating its harness session.

Use workflow_send instead when you want the worker to stop investigating
but still return its current findings.
`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["worker"],
      properties: {
        runId: {
          type: "string",
          description: "Workflow run ID. Defaults to the latest run.",
        },
        worker: {
          type: "string",
          enum: [...BUILT_IN_ROLE_ORDER],
          description: "Worker: tests, code-review, or readability.",
        },
      },
    },
  },
  workflow_retry: {
    description: `
Restart a failed, stuck, stopped, or unsatisfactory workflow worker.

The existing worker tab is closed if it still exists, then a fresh Herdr tab
and session for the worker's persisted agent kind are created with the
original objective and methodology snapshot.

A stale report is diagnostic evidence and never satisfies review completion.
Use workflow_retry to capture a fresh source checkpoint and rerun the affected
worker.
`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["worker"],
      properties: {
        runId: {
          type: "string",
          description: "Workflow run ID. Defaults to the latest run.",
        },
        worker: {
          type: "string",
          enum: [...BUILT_IN_ROLE_ORDER],
          description: "Worker: tests, code-review, or readability.",
        },
        additionalInstruction: {
          type: "string",
          minLength: 1,
          maxLength: 8_000,
          description: "Optional extra guidance for this retry attempt.",
        },
      },
    },
  },
} as const;

export type WorkflowToolName = keyof typeof WORKFLOW_TOOL_DESCRIPTORS;
