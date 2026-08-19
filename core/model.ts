import { createHash } from "node:crypto";

export const AGENT_KINDS = ["kilo", "claude", "codex"] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];

export const ROLE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export const BUILT_IN_ROLE_ORDER = [
  "tests",
  "code-review",
  "readability",
] as const;

export type BuiltInRoleId = (typeof BUILT_IN_ROLE_ORDER)[number];

// These aliases keep the Phase 1 business-level worker API separate from the
// generic role IDs used by persisted version-2 records.
export const WORKER_ORDER = BUILT_IN_ROLE_ORDER;
export type WorkerKind = BuiltInRoleId;
export type RoleId = string;

export const BUILT_IN_ROLE_DEFINITIONS = [
  {
    roleId: "tests",
    label: "Tests",
    skillId: "test-verification",
  },
  {
    roleId: "code-review",
    label: "Code Review",
    skillId: "code-review",
  },
  {
    roleId: "readability",
    label: "Readability",
    skillId: "readability-review",
  },
] as const;

export const WORKER_STATES = [
  "launching",
  "working",
  "blocked",
  "done",
  "idle",
  "unknown",
  "stopped",
  "error",
  "stale",
  "invalid-report",
] as const;

export type WorkerState = (typeof WORKER_STATES)[number];

export const RUN_STATES = [
  "launching",
  "reviewing",
  "blocked",
  "reviews-complete",
  "error",
  "stopped",
] as const;

export type RunState = (typeof RUN_STATES)[number];

export const WORKFLOW_NOTIFICATION_KINDS = [
  "worker-blocked",
  "worker-error",
  "worker-stale",
  "worker-invalid-report",
  "reviews-complete",
] as const;

export type WorkflowNotificationKind =
  (typeof WORKFLOW_NOTIFICATION_KINDS)[number];

export const ENFORCEMENT_STRENGTHS = ["strong", "moderate", "weak"] as const;

export type EnforcementStrength = (typeof ENFORCEMENT_STRENGTHS)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface SkillSnapshot {
  id: string;
  hash: string;
  body: string;
}

export interface EnforcementMetadata {
  profile: string;
  strength: EnforcementStrength;
  allowsWrites: boolean;
}

export interface WorkerDefinition {
  roleId: RoleId;
  label: string;
  agentKind: AgentKind;
  skill: SkillSnapshot;
  capabilityProfile: string;
  enforcement: EnforcementMetadata;
}

export interface OriginMetadata {
  workspaceId: string;
  paneId: string;
  coordinatorKind: AgentKind;
  sessionId?: string;
}

export interface SourceCheckpoint {
  headId?: string;
  stagedDiffSha256: string;
  unstagedTrackedDiffSha256: string;
  capturedAt: string;
}

export interface StaleWorkerDetails {
  baseline: SourceCheckpoint;
  current: SourceCheckpoint;
  reason: string;
}

export interface WorkerResult {
  // `output` is the bounded raw worker output retained for audit evidence.
  output: string;
  capturedAt: string;
  report?: JsonValue;
}

export interface WorkerAttemptEvidence {
  attempt: number;
  definition: WorkerDefinition;
  sourceCheckpoint?: SourceCheckpoint;
  agentName?: string;
  tabId?: string;
  paneId?: string;
  state: WorkerState;
  lastError?: string;
  result?: WorkerResult;
  staleDetails?: StaleWorkerDetails;
  closedAt?: string;
  cleanupError?: string;
}

export interface WorkflowNotification {
  sequence: number;
  key: string;
  kind: WorkflowNotificationKind;
  message: string;
  createdAt: string;
  deliveryError?: string;
  deliveredAt?: string;
}

export interface WorkerRecord {
  // `kind` is the role ID in persisted records. The name remains as a small
  // compatibility surface for the Phase 1 worker services.
  kind: RoleId;
  roleId?: RoleId;
  attempt: number;
  definition?: WorkerDefinition;
  agentName?: string;
  tabId?: string;
  paneId?: string;
  pendingPromptStartSeq?: number;
  stateChangeSeq?: number;
  state: WorkerState;
  lastError?: string;
  attemptHistory?: WorkerAttemptEvidence[];
  sourceCheckpoint?: SourceCheckpoint;
  result?: WorkerResult;
  staleDetails?: StaleWorkerDetails;
  closedAt?: string;
  cleanupError?: string;
}

export type WorkerMap = Record<RoleId, WorkerRecord>;

export interface WorkflowRun {
  version: 1 | 2;
  id: string;
  task: string;
  taskCardPath?: string;
  originSessionId?: string;
  herdrWorkspaceId?: string;
  createdAt: string;
  updatedAt: string;
  state: RunState;
  workerOrder?: RoleId[];
  origin?: OriginMetadata;
  workers: WorkerMap;
  nextNotificationSequence?: number;
  notifications?: WorkflowNotification[];
}

export interface WorkflowRunV2 extends WorkflowRun {
  version: 2;
  workerOrder: RoleId[];
  origin: OriginMetadata;
}

export interface WorkerSummary {
  roleId: RoleId;
  state: WorkerState;
  attempt: number;
  agentKind?: AgentKind;
  enforcement?: EnforcementMetadata;
  agentName?: string;
  tabId?: string;
  paneId?: string;
  error?: string;
  capturedAt?: string;
  attemptHistory?: WorkerAttemptEvidence[];
  sourceCheckpoint?: SourceCheckpoint;
  staleDetails?: StaleWorkerDetails;
  closedAt?: string;
  cleanupError?: string;
}

export function isAgentKind(value: unknown): value is AgentKind {
  return AGENT_KINDS.some((kind) => kind === value);
}

export function isRoleId(value: unknown): value is RoleId {
  return typeof value === "string" && ROLE_ID_PATTERN.test(value);
}

export function isWorkerKind(value: unknown): value is WorkerKind {
  return BUILT_IN_ROLE_ORDER.some((kind) => kind === value);
}

export function isWorkerState(value: unknown): value is WorkerState {
  return WORKER_STATES.some((state) => state === value);
}

export function isRunState(value: unknown): value is RunState {
  return RUN_STATES.some((state) => state === value);
}

export function isWorkflowNotificationKind(
  value: unknown,
): value is WorkflowNotificationKind {
  return WORKFLOW_NOTIFICATION_KINDS.some((kind) => kind === value);
}

export function isEnforcementStrength(
  value: unknown,
): value is EnforcementStrength {
  return ENFORCEMENT_STRENGTHS.some((strength) => strength === value);
}

export function isRoleOrder(value: unknown): value is RoleId[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isRoleId) &&
    new Set(value).size === value.length
  );
}

export function isSkillSnapshot(value: unknown): value is SkillSnapshot {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isSha256(value.hash) &&
    typeof value.body === "string" &&
    value.body.trim().length > 0 &&
    createHash("sha256").update(value.body, "utf8").digest("hex") ===
      value.hash
  );
}

export function isEnforcementMetadata(
  value: unknown,
): value is EnforcementMetadata {
  return (
    isRecord(value) &&
    isNonEmptyString(value.profile) &&
    isEnforcementStrength(value.strength) &&
    typeof value.allowsWrites === "boolean"
  );
}

export function isWorkerDefinition(
  value: unknown,
): value is WorkerDefinition {
  return (
    isRecord(value) &&
    isRoleId(value.roleId) &&
    isNonEmptyString(value.label) &&
    isAgentKind(value.agentKind) &&
    isSkillSnapshot(value.skill) &&
    isNonEmptyString(value.capabilityProfile) &&
    isEnforcementMetadata(value.enforcement)
  );
}

export function isOriginMetadata(value: unknown): value is OriginMetadata {
  return (
    isRecord(value) &&
    isNonEmptyString(value.workspaceId) &&
    isNonEmptyString(value.paneId) &&
    isAgentKind(value.coordinatorKind) &&
    isOptionalNonEmptyString(value.sessionId)
  );
}

export function isSourceCheckpoint(
  value: unknown,
): value is SourceCheckpoint {
  return (
    isRecord(value) &&
    isOptionalNonEmptyString(value.headId) &&
    isSha256(value.stagedDiffSha256) &&
    isSha256(value.unstagedTrackedDiffSha256) &&
    isIsoDate(value.capturedAt)
  );
}

export function isWorkerResult(value: unknown): value is WorkerResult {
  return (
    isRecord(value) &&
    typeof value.output === "string" &&
    isIsoDate(value.capturedAt) &&
    (value.report === undefined || isJsonValue(value.report))
  );
}

function isWorkerAttemptEvidence(
  value: unknown,
): value is WorkerAttemptEvidence {
  return (
    isRecord(value) &&
    Number.isInteger(value.attempt) &&
    (value.attempt as number) >= 0 &&
    isWorkerDefinition(value.definition) &&
    isOptionalString(value.agentName) &&
    isOptionalString(value.tabId) &&
    isOptionalString(value.paneId) &&
    isWorkerState(value.state) &&
    isOptionalString(value.lastError) &&
    (value.sourceCheckpoint === undefined ||
      isSourceCheckpoint(value.sourceCheckpoint)) &&
    (value.result === undefined || isWorkerResult(value.result)) &&
    (value.staleDetails === undefined ||
      isStaleWorkerDetails(value.staleDetails)) &&
    isOptionalIsoDate(value.closedAt) &&
    isOptionalString(value.cleanupError)
  );
}

function isOptionalAttemptHistory(
  value: unknown,
  roleId?: unknown,
): value is WorkerAttemptEvidence[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (evidence) =>
          isWorkerAttemptEvidence(evidence) &&
          (roleId === undefined || evidence.definition.roleId === roleId),
      ))
  );
}

export function isWorkerRecord(value: unknown): value is WorkerRecord {
  if (
    !isRecord(value) ||
    !isRoleId(value.kind) ||
    (value.roleId !== undefined && value.roleId !== value.kind) ||
    !Number.isInteger(value.attempt) ||
    (value.attempt as number) < 0 ||
    (value.definition !== undefined &&
      (!isWorkerDefinition(value.definition) ||
        value.definition.roleId !== value.kind)) ||
    !isOptionalString(value.agentName) ||
    !isOptionalString(value.tabId) ||
    !isOptionalString(value.paneId) ||
    !isOptionalNonNegativeInteger(value.pendingPromptStartSeq) ||
    !isOptionalNonNegativeInteger(value.stateChangeSeq) ||
    !isWorkerState(value.state) ||
    !isOptionalString(value.lastError) ||
    !isOptionalAttemptHistory(value.attemptHistory, value.kind) ||
    (value.sourceCheckpoint !== undefined &&
      !isSourceCheckpoint(value.sourceCheckpoint)) ||
    (value.result !== undefined && !isWorkerResult(value.result)) ||
    (value.staleDetails !== undefined &&
      !isStaleWorkerDetails(value.staleDetails)) ||
    !isOptionalIsoDate(value.closedAt) ||
    !isOptionalString(value.cleanupError)
  ) {
    return false;
  }

  return true;
}

export function isWorkerMap(
  value: unknown,
  workerOrder?: readonly RoleId[],
): value is WorkerMap {
  if (!isRecord(value)) {
    return false;
  }

  const keys = Object.keys(value);
  const order = workerOrder ?? keys;

  return (
    isRoleOrder(order) &&
    keys.length === order.length &&
    order.every(
      (roleId) =>
        Object.prototype.hasOwnProperty.call(value, roleId) &&
        isWorkerRecord(value[roleId]) &&
        value[roleId].kind === roleId,
    )
  );
}

export function isWorkflowRun(value: unknown): value is WorkflowRunV2 {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.task) ||
    !isIsoDate(value.createdAt) ||
    !isIsoDate(value.updatedAt) ||
    !isRunState(value.state) ||
    !isRoleOrder(value.workerOrder) ||
    !isOriginMetadata(value.origin) ||
    !isWorkerMap(value.workers, value.workerOrder) ||
    !isOptionalString(value.taskCardPath) ||
    !isCompatibleOriginAlias(value.originSessionId, value.origin.sessionId) ||
    !isCompatibleOriginAlias(value.herdrWorkspaceId, value.origin.workspaceId) ||
    !isOptionalPositiveInteger(value.nextNotificationSequence) ||
    !isOptionalNotificationArray(value.notifications)
  ) {
    return false;
  }

  return value.workerOrder.every(
    (roleId) => value.workers[roleId].definition !== undefined,
  );
}

export function deriveRunState(run: WorkflowRun): RunState {
  const workerOrder = run.workerOrder ?? WORKER_ORDER;

  if (!isRoleOrder(workerOrder) || !isWorkerMap(run.workers, workerOrder)) {
    throw new Error("Cannot derive workflow state from an invalid worker map.");
  }

  const states = workerOrder.map((roleId) => run.workers[roleId].state);

  if (states.every((state) => state === "stopped")) {
    return "stopped";
  }

  if (states.some((state) => state === "error" || state === "unknown")) {
    return "error";
  }

  // Stale and invalid reports require coordinator action and must never count
  // as completed reviews.
  if (
    states.some(
      (state) => state === "blocked" || state === "stale" || state === "invalid-report",
    )
  ) {
    return "blocked";
  }

  if (
    states.every(
      (state) =>
        state === "done" ||
        state === "idle" ||
        state === "stopped",
    )
  ) {
    return "reviews-complete";
  }

  if (states.some((state) => state === "launching")) {
    return "launching";
  }

  return "reviewing";
}

export function refreshRunState(run: WorkflowRun): void {
  run.state = deriveRunState(run);
  run.updatedAt = new Date().toISOString();
}

export function createReplacementWorker(
  existing: WorkerRecord,
  attempt: number,
  sourceCheckpoint: SourceCheckpoint,
): WorkerRecord {
  if (!existing.definition) {
    throw new Error(
      `Workflow worker ${existing.kind} has no persisted definition for retry.`,
    );
  }

  return {
    kind: existing.kind,
    roleId: existing.roleId ?? existing.kind,
    attempt,
    definition: existing.definition,
    attemptHistory: archiveWorkerAttempt(existing),
    sourceCheckpoint,
    state: "launching",
  };
}

export function archiveWorkerAttempt(
  worker: WorkerRecord,
): WorkerAttemptEvidence[] {
  return [...(worker.attemptHistory ?? []), createAttemptEvidence(worker)];
}

export function enqueueWorkflowNotification(
  run: WorkflowRun,
  notification: {
    key: string;
    kind: WorkflowNotificationKind;
    message: string;
  },
): WorkflowNotification {
  const notifications = (run.notifications ??= []);
  const existing = notifications.find(
    (candidate) => candidate.key === notification.key,
  );

  if (existing) {
    return existing;
  }

  const sequence = Math.max(
    run.nextNotificationSequence ?? 1,
    (notifications.at(-1)?.sequence ?? 0) + 1,
  );
  const created: WorkflowNotification = {
    sequence,
    key: notification.key,
    kind: notification.kind,
    message: notification.message,
    createdAt: new Date().toISOString(),
  };

  notifications.push(created);
  run.nextNotificationSequence = sequence + 1;
  return created;
}

export function createAgentName(
  runId: string,
  roleId: RoleId,
  attempt: number,
): string {
  if (!isRoleId(roleId)) {
    throw new Error(`Invalid workflow role ID "${roleId}".`);
  }

  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error(`Invalid workflow attempt "${attempt}".`);
  }

  const runPrefix = runId
    .replace(/^run-/, "")
    .replaceAll("-", "")
    .slice(0, runId.length === 12 ? 8 : 12);

  return `wf-${runPrefix}-${roleId}-${attempt}`;
}

export function isLegacyAgentName(
  agentName: unknown,
  runId: string,
  roleId: RoleId,
  attempt: number,
): boolean {
  const legacySuffix =
    roleId === "tests"
      ? "tests"
      : roleId === "code-review"
        ? "review"
        : roleId === "readability"
          ? "readable"
          : undefined;

  if (legacySuffix === undefined) {
    return false;
  }

  const runPrefix = runId
    .replace(/^run-/, "")
    .replaceAll("-", "")
    .slice(0, runId.length === 12 ? 8 : 12);

  return agentName === `wf-${runPrefix}-${legacySuffix}-${attempt}`;
}

export function summarizeWorkers(
  run: WorkflowRun,
): Record<RoleId, WorkerSummary> {
  const workerOrder = run.workerOrder ?? WORKER_ORDER;

  return Object.fromEntries(
    workerOrder.map((roleId) => {
      const worker = run.workers[roleId];
      const definition = worker.definition;

      return [
        roleId,
        {
          roleId,
          state: worker.state,
          attempt: worker.attempt,
          agentKind: definition?.agentKind,
          enforcement: definition?.enforcement,
          agentName: worker.agentName,
          tabId: worker.tabId,
          paneId: worker.paneId,
          error: worker.lastError,
          capturedAt: worker.result?.capturedAt,
          attemptHistory: worker.attemptHistory,
          sourceCheckpoint: worker.sourceCheckpoint,
          staleDetails: worker.staleDetails,
          closedAt: worker.closedAt,
          cleanupError: worker.cleanupError,
        },
      ];
    }),
  ) as Record<RoleId, WorkerSummary>;
}

function isStaleWorkerDetails(value: unknown): value is StaleWorkerDetails {
  return (
    isRecord(value) &&
    isSourceCheckpoint(value.baseline) &&
    isSourceCheckpoint(value.current) &&
    isNonEmptyString(value.reason)
  );
}

function createAttemptEvidence(existing: WorkerRecord): WorkerAttemptEvidence {
  if (!existing.definition) {
    throw new Error(
      `Workflow worker ${existing.kind} has no persisted definition for retry.`,
    );
  }

  return {
    attempt: existing.attempt,
    definition: existing.definition,
    sourceCheckpoint: existing.sourceCheckpoint,
    agentName: existing.agentName,
    tabId: existing.tabId,
    paneId: existing.paneId,
    state: existing.state,
    lastError: existing.lastError,
    result: existing.result,
    staleDetails: existing.staleDetails,
    closedAt: existing.closedAt,
    cleanupError: existing.cleanupError,
  };
}

function isOptionalNotificationArray(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }

  if (!Array.isArray(value)) {
    return false;
  }

  let previousSequence = 0;

  for (const notification of value) {
    if (
      !isRecord(notification) ||
      !Number.isInteger(notification.sequence) ||
      (notification.sequence as number) <= previousSequence ||
      !isNonEmptyString(notification.key) ||
      !isWorkflowNotificationKind(notification.kind) ||
      !isNonEmptyString(notification.message) ||
      !isIsoDate(notification.createdAt) ||
      !isOptionalString(notification.deliveryError) ||
      !isOptionalIsoDate(notification.deliveredAt)
    ) {
      return false;
    }

    previousSequence = notification.sequence as number;
  }

  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (!isRecord(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(value).every(isJsonValue)
  );
}

function isCompatibleOriginAlias(
  alias: unknown,
  canonical: string | undefined,
): boolean {
  return alias === undefined || (typeof alias === "string" && alias === canonical);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalIsoDate(value: unknown): value is string | undefined {
  return value === undefined || isIsoDate(value);
}

function isOptionalPositiveInteger(value: unknown): boolean {
  return (
    value === undefined ||
    (Number.isInteger(value) && (value as number) > 0)
  );
}

function isOptionalNonNegativeInteger(
  value: unknown,
): value is number | undefined {
  return (
    value === undefined ||
    (Number.isInteger(value) && (value as number) >= 0)
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
