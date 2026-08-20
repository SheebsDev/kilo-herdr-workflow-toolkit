import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import { parse as parseToml } from "toml";

import type { JsonValue } from "./model.ts";
import { hashOwnedValue } from "./ownership-manifest.ts";
import type {
  ExactResourceState,
  InstallTransitionAdapter,
  OpaqueAdapterChange,
  OpaqueRegistrationTransition,
  ObservedOpaqueSemanticState,
  PreparedTransition,
  PreparedTransitionDisposition,
  ResourcePostimage,
  TransitionAdapterContext,
  TransitionObservation,
  TransitionReceipt,
} from "./executable-install-plan.ts";

type JsonObject = { [key: string]: JsonValue };
type KeyPath = readonly string[];
type MultilineDelimiter = "\"\"\"" | "'''";

interface CodexTomlPreparedHandle {
  readonly token: symbol;
  readonly transitionId: string;
  readonly baselineValues: ReadonlyMap<string, JsonObject | undefined>;
  readonly baselineMode?: number;
}

interface CodexTomlResource {
  readonly state: ExactResourceState;
  readonly source: string;
  readonly values: ReadonlyMap<string, JsonObject | undefined>;
  readonly mode?: number;
}

interface SourceLine {
  readonly start: number;
  readonly end: number;
  readonly body: string;
}

interface TableMatch {
  readonly kind: "table";
  readonly start: number;
  end: number;
  readonly header: string;
}

interface InlineMatch {
  readonly kind: "inline";
  readonly start: number;
  readonly end: number;
  readonly valueStart: number;
  readonly valueEnd: number;
}

interface DottedMatch {
  readonly kind: "dotted";
  readonly lines: readonly SourceLine[];
}

type TargetMatch = TableMatch | InlineMatch | DottedMatch;

/**
 * Mutates only named Codex MCP server tables. TOML is parsed for correctness,
 * while the source text is edited by span so unrelated comments and bytes are
 * not normalized by a parse/stringify round trip.
 */
export class CodexTomlInstallAdapter implements InstallTransitionAdapter {
  private readonly handles = new Map<string, CodexTomlPreparedHandle>();

  async inspect(
    context: TransitionAdapterContext,
    signal: AbortSignal,
  ): Promise<TransitionObservation> {
    const transition = assertCodexTransition(context.transition);
    throwIfAborted(signal);
    const resource = await readResource(signal, false, transition);
    return {
      transitionId: transition.id,
      state: resource.state,
      semantics: semanticStates(transition, resource.values),
    };
  }

  async prepare(
    context: TransitionAdapterContext,
    observation: TransitionObservation,
    signal: AbortSignal,
  ): Promise<PreparedTransition> {
    const transition = assertCodexTransition(context.transition);
    throwIfAborted(signal);
    const resource = await readResource(signal, false, transition);
    if (!resourceStatesEqual(resource.state, transition.baseline)) {
      throw new Error(`Transition "${transition.id}" was not prepared from its baseline.`);
    }
    if (
      observation.transitionId !== transition.id ||
      !resourceStatesEqual(observation.state, transition.baseline)
    ) {
      throw new Error(`Transition "${transition.id}" received an invalid baseline observation.`);
    }
    assertBaselineSemantics(transition, resource.values);
    const handle: CodexTomlPreparedHandle = {
      token: Symbol(transition.id),
      transitionId: transition.id,
      baselineValues: new Map(
        transition.stage.changes.map((change) => [
          change.semanticId,
          cloneObject(resource.values.get(change.semanticId)),
        ]),
      ),
      baselineMode: resource.mode,
    };
    if (this.handles.has(transition.id)) {
      throw new Error(`Transition "${transition.id}" was prepared more than once.`);
    }
    this.handles.set(transition.id, handle);
    return {
      transitionId: transition.id,
      postimage: structuredClone(transition.desired),
      stagingHandle: handle,
    };
  }

  async apply(
    context: TransitionAdapterContext,
    prepared: PreparedTransition,
    signal: AbortSignal,
  ): Promise<TransitionReceipt> {
    const transition = assertCodexTransition(context.transition);
    const handle = this.requireHandle(transition, prepared);
    throwIfAborted(signal);

    const current = await readResource(signal, true, transition);
    assertExactState(current.state, transition.baseline, transition.id, "apply");
    assertBaselineSemantics(transition, current.values);
    const nextSource = applyChanges(current.source, transition.stage.changes);
    await writeResource(
      resolveTargetPath(transition),
      nextSource,
      current.mode ?? handle.baselineMode ?? 0o600,
      signal,
    );

    const next = await readResource(signal, true, transition);
    return {
      transitionId: transition.id,
      operation: "apply",
      before: structuredClone(transition.baseline),
      after: structuredClone(transition.desired),
      semantics: semanticStates(transition, next.values),
    };
  }

  async rollback(
    context: TransitionAdapterContext,
    preparedReceipt: TransitionReceipt | undefined,
    signal: AbortSignal,
  ): Promise<TransitionReceipt> {
    const transition = assertCodexTransition(context.transition);
    const handle = this.requireHandleById(transition);
    if (
      preparedReceipt &&
      (preparedReceipt.transitionId !== transition.id ||
        preparedReceipt.operation !== "apply")
    ) {
      throw new Error(`Transition "${transition.id}" received an invalid apply receipt.`);
    }
    throwIfAborted(signal);

    const current = await readResource(signal, true, transition);
    assertDesiredSemantics(transition, current.values);
    const nextSource = applyChanges(
      current.source,
      transition.stage.changes.map((change) => ({
        ...change,
        action: handle.baselineValues.get(change.semanticId) === undefined
          ? "remove"
          : "restore",
        desiredValue: handle.baselineValues.get(change.semanticId),
      })),
    );
    if (transition.baseline.type === "absent" && nextSource === "") {
      await rm(resolveTargetPath(transition), { force: true });
    } else {
      await writeResource(
        resolveTargetPath(transition),
        nextSource,
        current.mode ?? handle.baselineMode ?? 0o600,
        signal,
      );
    }

    const next = await readResource(signal, true, transition);
    return {
      transitionId: transition.id,
      operation: "rollback",
      before: structuredClone(transition.desired),
      after: structuredClone(transition.baseline),
      semantics: semanticStates(transition, next.values),
    };
  }

  async cleanup(
    context: TransitionAdapterContext,
    _prepared: PreparedTransition | undefined,
    _disposition: PreparedTransitionDisposition,
    signal: AbortSignal,
  ): Promise<void> {
    const transition = assertCodexTransition(context.transition);
    throwIfAborted(signal);
    this.handles.delete(transition.id);
  }

  private requireHandle(
    transition: OpaqueRegistrationTransition,
    prepared: PreparedTransition,
  ): CodexTomlPreparedHandle {
    const handle = this.requireHandleById(transition);
    if (prepared.transitionId !== transition.id || prepared.stagingHandle !== handle) {
      throw new Error(`Transition "${transition.id}" received unknown staged output.`);
    }
    return handle;
  }

  private requireHandleById(
    transition: OpaqueRegistrationTransition,
  ): CodexTomlPreparedHandle {
    const handle = this.handles.get(transition.id);
    if (!handle || handle.token.description !== transition.id) {
      throw new Error(`Transition "${transition.id}" has no private rollback state.`);
    }
    return handle;
  }
}

function assertCodexTransition(
  transition: TransitionAdapterContext["transition"],
): OpaqueRegistrationTransition {
  if (
    transition.kind !== "opaque-registration" ||
    transition.desired.adapterKind !== "codex-toml" ||
    transition.stage.type !== "adapter-prepare" ||
    transition.stage.adapterKind !== "codex-toml"
  ) {
    throw new Error(`Transition "${transition.id}" is not a Codex TOML registration.`);
  }
  const keys = transition.stage.changes.map((change) => change.key);
  if (new Set(keys).size !== keys.length) {
    throw new Error(`Transition "${transition.id}" contains duplicate Codex registration keys.`);
  }
  for (const change of transition.stage.changes) assertCodexChange(change);
  return transition;
}

function assertCodexChange(change: OpaqueAdapterChange): void {
  const key = parseKeyPath(change.key);
  if (
    key.length !== 2 ||
    key[0] !== "mcp_servers" ||
    !key[1] ||
    (change.action !== "remove" && !isJsonObject(change.desiredValue))
  ) {
    throw new Error(
      `Codex registration key "${change.key}" must name one mcp_servers table.`,
    );
  }
}

async function readResource(
  signal: AbortSignal,
  requireParent: boolean,
  transition: OpaqueRegistrationTransition,
): Promise<CodexTomlResource> {
  const targetPath = await assertSafeTarget(transition, requireParent);
  throwIfAborted(signal);
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(targetPath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return {
        state: { type: "absent" },
        source: "",
        values: valuesFor(transition, {}),
      };
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Codex configuration is not a physical file: ${targetPath}`);
  }
  const source = await readFile(targetPath, "utf8");
  const after = await lstat(targetPath);
  if (
    info.dev !== after.dev ||
    info.ino !== after.ino ||
    info.size !== after.size ||
    info.mtimeMs !== after.mtimeMs
  ) {
    throw new Error(`Codex configuration changed while it was being read: ${targetPath}`);
  }
  const document = parseSource(source, targetPath);
  const values = valuesFor(transition, document);
  const hasInlineServerRoot = hasRootMcpServersAssignment(source);
  for (const change of transition.stage.changes) {
    const key = parseKeyPath(change.key);
    const match = findTarget(source, key);
    const hasValue = values.get(change.semanticId) !== undefined;
    const unsupportedRepresentation = !match && (hasValue || hasInlineServerRoot);
    if (unsupportedRepresentation) {
      throw new Error(`Codex registration "${change.key}" uses an unsupported TOML representation.`);
    }
  }
  return {
    state: { type: "file", sha256: hashText(source) },
    source,
    values,
    mode: info.mode & 0o777,
  };
}

function parseSource(source: string, targetPath: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = parseToml(source) as unknown;
  } catch (error) {
    throw new Error(`Codex configuration is not valid TOML: ${targetPath}: ${errorMessage(error)}`);
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`Codex configuration must be a TOML table: ${targetPath}`);
  }
  if (parsed.mcp_servers !== undefined && !isJsonObject(parsed.mcp_servers)) {
    throw new Error(`Codex configuration has an ambiguous mcp_servers value: ${targetPath}`);
  }
  return parsed;
}

function valuesFor(
  transition: OpaqueRegistrationTransition,
  document: JsonObject,
): ReadonlyMap<string, JsonObject | undefined> {
  const values = new Map<string, JsonObject | undefined>();
  const servers = isJsonObject(document.mcp_servers) ? document.mcp_servers : {};
  for (const change of transition.stage.changes) {
    const key = parseKeyPath(change.key)[1];
    const value = Object.prototype.hasOwnProperty.call(servers, key) ? servers[key] : undefined;
    if (value !== undefined && !isJsonObject(value)) {
      throw new Error(`Codex registration "${change.key}" is not a TOML table.`);
    }
    values.set(change.semanticId, cloneObject(value));
  }
  return values;
}

function semanticStates(
  transition: OpaqueRegistrationTransition,
  values: ReadonlyMap<string, JsonObject | undefined>,
): ObservedOpaqueSemanticState[] {
  return transition.stage.changes.map((change) => {
    const value = values.get(change.semanticId);
    return value === undefined
      ? {
          semanticId: change.semanticId,
          harness: change.harness,
          key: change.key,
          state: "absent" as const,
        }
      : {
          semanticId: change.semanticId,
          harness: change.harness,
          key: change.key,
          state: "value" as const,
          valueSha256: hashOwnedValue(value),
        };
  });
}

function assertBaselineSemantics(
  transition: OpaqueRegistrationTransition,
  values: ReadonlyMap<string, JsonObject | undefined>,
): void {
  for (const change of transition.stage.changes) {
    const value = values.get(change.semanticId);
    const actualHash = value === undefined ? undefined : hashOwnedValue(value);
    if (actualHash !== change.expectedValueSha256) {
      throw new Error(`Codex registration "${change.key}" changed from its planned baseline.`);
    }
  }
}

function assertDesiredSemantics(
  transition: OpaqueRegistrationTransition,
  values: ReadonlyMap<string, JsonObject | undefined>,
): void {
  for (const change of transition.stage.changes) {
    const value = values.get(change.semanticId);
    const actualHash = value === undefined ? undefined : hashOwnedValue(value);
    const expectedHash = change.action === "remove"
      ? undefined
      : hashOwnedValue(change.desiredValue!);
    if (actualHash !== expectedHash) {
      throw new Error(`Codex registration "${change.key}" was modified before rollback.`);
    }
  }
}

function applyChanges(
  source: string,
  changes: readonly OpaqueAdapterChange[],
): string {
  let next = source;
  for (const change of changes) {
    const key = parseKeyPath(change.key);
    const desired = change.action === "remove" ? undefined : change.desiredValue;
    const match = findTarget(next, key);
    next = replaceTarget(next, key, match, desired);
  }
  return next;
}

function findTarget(source: string, target: KeyPath): TargetMatch | undefined {
  const lines = splitLines(source);
  let currentTable: KeyPath | undefined;
  let multilineDelimiter: MultilineDelimiter | undefined;
  let table: TableMatch | undefined;
  let inline: InlineMatch | undefined;
  const dotted: SourceLine[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const previousDelimiter = multilineDelimiter;
    const scanned = scanTomlLine(line.body, multilineDelimiter);
    multilineDelimiter = scanned.delimiter;
    const code = scanned.code.trim();

    const header = parseTableHeader(code);
    if (header) {
      const isTargetDescendant =
        header.path.length > target.length &&
        header.path.slice(0, target.length).every((part, partIndex) => part === target[partIndex]);
      if (isTargetDescendant) {
        throw new Error(`Codex registration "${target.join(".")}" uses an unsupported descendant table.`);
      }
      currentTable = header.path;
      if (sameKey(header.path, target)) {
        if (header.array) throw new Error(`Codex registration "${target.join(".")}" is an array table.`);
        if (table) throw ambiguousTarget(target);
        table = {
          kind: "table",
          start: line.start,
          end: line.end,
          header: line.body,
        };
      }
      continue;
    }

    if (currentTable && sameKey(currentTable, target)) {
      if (table && (code || previousDelimiter || multilineDelimiter)) {
        table.end = line.end;
      }
      continue;
    }
    if (!code) continue;
    const assignment = parseAssignment(code);
    if (!assignment) continue;
    const absolute = currentTable
      ? [...currentTable, ...assignment.path]
      : assignment.path;
    const isTarget = sameKey(absolute, target);
    const isTargetDescendant =
      absolute.length > target.length &&
      absolute.slice(0, target.length).every((part, partIndex) => part === target[partIndex]);
    if ((isTarget || isTargetDescendant) && valueNeedsContinuation(code.slice(assignment.equals + 1))) {
      throw new Error(`Codex registration "${target.join(".")}" uses an unsupported multiline value.`);
    }
    if (isTarget) {
      if (inline || dotted.length > 0 || table) throw ambiguousTarget(target);
      const codeOffset = line.body.indexOf(code);
      const lineOffset = line.start + codeOffset;
      const equalsOffset = lineOffset + assignment.equals;
      const valueStart = equalsOffset + 1 + leadingWhitespace(line.body.slice(equalsOffset + 1));
      const valueEnd = lineOffset + assignment.valueEndInCode;
      inline = {
        kind: "inline",
        start: line.start,
        end: line.end,
        valueStart,
        valueEnd,
      };
    } else if (
      isTargetDescendant
    ) {
      if (table || inline) throw ambiguousTarget(target);
      dotted.push(line);
    }
  }

  if (table) return table;
  if (inline) return inline;
  if (dotted.length > 0) return { kind: "dotted", lines: dotted };
  return undefined;
}

function replaceTarget(
  source: string,
  target: KeyPath,
  match: TargetMatch | undefined,
  desired: JsonValue | undefined,
): string {
  if (!match) {
    if (desired === undefined) return source;
    const newline = lineEnding(source);
    const separator = source.length === 0 || /(?:\r\n|\r|\n)$/.test(source) ? "" : newline;
    return `${source}${separator}[${formatKey("mcp_servers")}.${formatKey(target[1])}]${newline}${formatTable(desired, newline)}`;
  }

  if (match.kind === "table") {
    if (desired === undefined) return source.slice(0, match.start) + source.slice(match.end);
    const newline = lineEnding(source);
    return `${source.slice(0, match.start)}${formatHeader(match.header)}${newline}${formatTable(desired, newline)}${source.slice(match.end)}`;
  }

  if (match.kind === "inline") {
    if (desired === undefined) return source.slice(0, match.start) + source.slice(match.end);
    return `${source.slice(0, match.valueStart)}${formatValue(desired)}${source.slice(match.valueEnd)}`;
  }

  const first = match.lines[0];
  const newline = lineEnding(source);
  let result = source;
  for (const line of [...match.lines].reverse()) {
    result = result.slice(0, line.start) + result.slice(line.end);
  }
  if (desired === undefined) return result;
    const insertion = `${formatKeyPath(target)} = ${formatValue(desired)}${newline}`;
  return result.slice(0, first.start) + insertion + result.slice(first.start);
}

function formatHeader(header: string): string {
  const commentIndex = findComment(header);
  return commentIndex < 0 ? header.trimEnd() : header.slice(0, commentIndex).trimEnd() + header.slice(commentIndex);
}

function formatTable(value: JsonValue, newline: string): string {
  if (!isJsonObject(value)) throw new Error("Codex MCP registration must be a TOML table.");
  return Object.entries(value)
    .map(([key, entry]) => `${formatKey(key)} = ${formatValue(entry)}${newline}`)
    .join("");
}

function formatValue(value: JsonValue): string {
  if (value === null) throw new Error("Codex TOML does not support null registration values.");
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Codex TOML values must be finite.");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(formatValue).join(", ")}]`;
  return `{ ${Object.entries(value).map(([key, entry]) => `${formatKey(key)} = ${formatValue(entry)}`).join(", ")} }`;
}

function formatKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}

function formatKeyPath(value: KeyPath): string {
  return value.map(formatKey).join(".");
}

function parseTableHeader(code: string): { path: KeyPath; array: boolean } | undefined {
  if (!code.startsWith("[") || !code.endsWith("]")) return undefined;
  const array = code.startsWith("[[") && code.endsWith("]]");
  const body = array ? code.slice(2, -2).trim() : code.slice(1, -1).trim();
  if (!body) throw new Error("Codex TOML contains an empty table header.");
  return { path: parseKeyPath(body), array };
}

function parseAssignment(code: string): { path: KeyPath; equals: number; valueEndInCode: number } | undefined {
  const equals = findUnquoted(code, "=");
  if (equals < 0) return undefined;
  const lhs = code.slice(0, equals).trim();
  const value = code.slice(equals + 1);
  if (!lhs || !value.trim()) return undefined;
  return {
    path: parseKeyPath(lhs),
    equals,
    valueEndInCode: code.length - trailingWhitespace(value).length,
  };
}

function hasRootMcpServersAssignment(source: string): boolean {
  let currentTable: KeyPath | undefined;
  let multilineDelimiter: MultilineDelimiter | undefined;
  for (const line of splitLines(source)) {
    const scanned = scanTomlLine(line.body, multilineDelimiter);
    multilineDelimiter = scanned.delimiter;
    const code = scanned.code.trim();
    if (!code) continue;
    const header = parseTableHeader(code);
    if (header) {
      currentTable = header.path;
      continue;
    }
    if (currentTable) continue;
    const assignment = parseAssignment(code);
    if (assignment && sameKey(assignment.path, ["mcp_servers"])) return true;
  }
  return false;
}

function valueNeedsContinuation(value: string): boolean {
  let quote = "";
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === '"' && character === "\\") {
      index += 1;
      continue;
    }
    if ((character === '"' || character === "'") && !quote) quote = character;
    else if (character === quote) quote = "";
    else if (!quote && "[{".includes(character)) depth += 1;
    else if (!quote && "]}".includes(character)) depth -= 1;
  }
  return depth > 0;
}

function parseKeyPath(source: string): string[] {
  const result: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] === '"' || source[cursor] === "'") {
      const quote = source[cursor];
      const start = cursor++;
      while (cursor < source.length) {
        if (source[cursor] === quote && (quote === "'" || source[cursor - 1] !== "\\")) break;
        cursor += 1;
      }
      if (source[cursor] !== quote) throw new Error(`Invalid TOML key path "${source}".`);
      const raw = source.slice(start, ++cursor);
      result.push(quote === '"' ? JSON.parse(raw) as string : raw.slice(1, -1));
    } else {
      const start = cursor;
      while (cursor < source.length && !/[.\s]/.test(source[cursor])) cursor += 1;
      const bare = source.slice(start, cursor);
      if (!/^[A-Za-z0-9_-]+$/.test(bare)) throw new Error(`Invalid TOML key path "${source}".`);
      result.push(bare);
    }
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (cursor === source.length) break;
    if (source[cursor] !== ".") throw new Error(`Invalid TOML key path "${source}".`);
    cursor += 1;
  }
  if (result.length === 0) throw new Error(`Invalid TOML key path "${source}".`);
  return result;
}

function splitLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline < 0 ? source.length : newline + 1;
    const bodyEnd = newline < 0 ? end : source[newline - 1] === "\r" ? newline - 1 : newline;
    lines.push({ start, end, body: source.slice(start, bodyEnd) });
    start = end;
  }
  return lines;
}

function scanTomlLine(
  source: string,
  initialDelimiter: MultilineDelimiter | undefined,
): { code: string; delimiter: MultilineDelimiter | undefined } {
  let delimiter = initialDelimiter;
  let code = "";
  let index = 0;
  while (index < source.length) {
    if (delimiter) {
      const close = source.indexOf(delimiter, index);
      if (close < 0) return { code, delimiter };
      delimiter = undefined;
      index = close + 3;
      continue;
    }
    const triple = source.startsWith("\"\"\"", index)
      ? "\"\"\""
      : source.startsWith("'''", index)
        ? "'''"
        : undefined;
    if (triple) {
      delimiter = triple;
      index += 3;
      continue;
    }
    const character = source[index];
    if (character === '"' || character === "'") {
      const quote = character;
      const start = index;
      index += 1;
      while (index < source.length) {
        if (quote === '"' && source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      code += source.slice(start, index);
      continue;
    }
    if (character === "#") break;
    code += character;
    index += 1;
  }
  return { code, delimiter };
}

function findComment(source: string): number {
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote === '"' && character === "\\") {
      index += 1;
      continue;
    }
    if ((character === '"' || character === "'") && !quote) quote = character;
    else if (character === quote) quote = "";
    else if (character === "#" && !quote) return index;
  }
  return -1;
}

function findUnquoted(source: string, wanted: string): number {
  let quote = "";
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote === '"' && character === "\\") {
      index += 1;
      continue;
    }
    if ((character === '"' || character === "'") && !quote) quote = character;
    else if (character === quote) quote = "";
    else if (!quote && "[{".includes(character)) depth += 1;
    else if (!quote && "]}".includes(character)) depth -= 1;
    else if (!quote && depth === 0 && character === wanted) return index;
  }
  return -1;
}

function lineEnding(source: string): "\r\n" | "\n" {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

function leadingWhitespace(source: string): number {
  const match = source.match(/^\s*/);
  return match?.[0].length ?? 0;
}

function trailingWhitespace(source: string): string {
  return source.match(/\s*$/)?.[0] ?? "";
}

function sameKey(left: KeyPath, right: KeyPath): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function ambiguousTarget(target: KeyPath): Error {
  return new Error(`Codex registration "${target.join(".")}" has ambiguous duplicate definitions.`);
}

function cloneObject(value: JsonObject | undefined): JsonObject | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertSafeTarget(
  transition: OpaqueRegistrationTransition,
  requireParent: boolean,
): Promise<string> {
  const root = transition.target.root;
  if (!path.isAbsolute(root) || path.resolve(root) !== root) {
    throw new Error(`Codex transition "${transition.id}" has a non-canonical root.`);
  }
  const components = transition.target.relativePath.split("/");
  if (
    !transition.target.relativePath ||
    components.some((component) =>
      !component || component === "." || component === ".." ||
      component.includes("\\") || component.toLowerCase() === ".workflow"
    )
  ) {
    throw new Error(`Codex transition "${transition.id}" has an unsafe target path.`);
  }
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Codex transition root is not a physical directory: ${root}`);
  }
  const rootRealPath = await realpath(root);
  let current = root;
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        if (requireParent && index < components.length - 1) {
          throw new Error(`Codex transition parent directory is missing: ${current}`);
        }
        break;
      }
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`Codex transition path contains a link or junction: ${current}`);
    if (index < components.length - 1 && !info.isDirectory()) throw new Error(`Codex transition path has a non-directory parent: ${current}`);
    if (index < components.length - 1 && !isPathInside(rootRealPath, await realpath(current))) {
      throw new Error(`Codex transition path escapes its resource root: ${current}`);
    }
  }
  return path.resolve(root, ...components);
}

function resolveTargetPath(transition: OpaqueRegistrationTransition): string {
  return path.resolve(transition.target.root, ...transition.target.relativePath.split("/"));
}

function resourceStatesEqual(left: ResourcePostimage, right: ResourcePostimage): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "file" && right.type === "file") return left.sha256 === right.sha256;
  return left.type === "absent" && right.type === "absent";
}

function assertExactState(
  actual: ExactResourceState,
  expected: ExactResourceState,
  transitionId: string,
  operation: string,
): void {
  if (!resourceStatesEqual(actual, expected)) throw new Error(`Transition "${transitionId}" changed before ${operation}.`);
}

async function writeResource(targetPath: string, source: string, mode: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, source, { flag: "wx", mode: mode || 0o600 });
    await chmod(temporaryPath, mode || 0o600);
    throwIfAborted(signal);
    if (process.platform !== "win32") {
      await rename(temporaryPath, targetPath);
    } else {
      const displacedPath = `${targetPath}.${randomUUID()}.old`;
      let displaced = false;
      try {
        try { await rename(targetPath, displacedPath); displaced = true; } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
        try { await rename(temporaryPath, targetPath); } catch (error) { if (displaced) await rename(displacedPath, targetPath); throw error; }
      } finally {
        if (displaced) await rm(displacedPath, { force: true }).catch(() => undefined);
      }
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error(signal.reason === undefined ? "The install operation was cancelled." : String(signal.reason));
  error.name = "AbortError";
  throw error;
}
