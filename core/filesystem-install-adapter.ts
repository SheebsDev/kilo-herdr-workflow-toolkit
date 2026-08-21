import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type {
  DependencyTreeTransition,
  ExactResourceState,
  InstallTransition,
  InstallTransitionAdapter,
  PreparedTransition,
  PreparedTransitionDisposition,
  ResourcePostimage,
  TransitionAdapterContext,
  TransitionObservation,
  TransitionReceipt,
} from "./executable-install-plan.ts";
import {
  copyFileSystemTree,
  removeFileSystemTree,
  snapshotFileSystemTree,
} from "./filesystem-tree.ts";

export type FileSystemInstallBoundary =
  | "inspect:before"
  | "inspect:after"
  | "prepare:before"
  | "prepare:after-stage"
  | "apply:before"
  | "apply:before-mutation"
  | "apply:after-mutation"
  | "rollback:before"
  | "rollback:before-mutation"
  | "rollback:after-mutation"
  | "cleanup:before"
  | "cleanup:after";

export interface FileSystemInstallFaultEvent {
  readonly boundary: FileSystemInstallBoundary;
  readonly context: TransitionAdapterContext;
}

export interface DependencyTreePrepareRequest {
  readonly context: TransitionAdapterContext & {
    readonly transition: DependencyTreeTransition;
  };
  readonly outputPath: string;
  readonly workPath: string;
  readonly signal: AbortSignal;
}

export interface FileSystemInstallAdapterOptions {
  /** Parent for restrictive transaction directories. Defaults to the OS temp directory. */
  readonly temporaryRoot?: string;
  readonly prepareDependencyTree?: (
    request: DependencyTreePrepareRequest,
  ) => Promise<void>;
  readonly injectFault?: (
    event: FileSystemInstallFaultEvent,
  ) => void | Promise<void>;
}

interface RootIdentity {
  readonly realPath: string;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

interface SiblingArtifact {
  readonly path: string;
  readonly state: ExactResourceState;
}

interface FileSystemPreparedHandle {
  readonly token: symbol;
  readonly transitionId: string;
  readonly directoryPath: string;
  readonly stagedPath?: string;
  readonly backupPath?: string;
  readonly workPath?: string;
  readonly recoveryArtifacts: readonly string[];
  readonly siblingArtifacts: Map<string, SiblingArtifact>;
  stagedMode?: number;
  baselineMode?: number;
}

/**
 * One adapter instance owns one transaction workspace. Create a fresh instance
 * for each executeInstallTransaction call and route opaque transitions to their
 * format-specific adapters.
 */
export class FileSystemInstallAdapter implements InstallTransitionAdapter {
  private readonly options: FileSystemInstallAdapterOptions;
  private readonly roots = new Map<string, RootIdentity>();
  private readonly handles = new Map<string, FileSystemPreparedHandle>();
  private workspacePath?: string;

  constructor(options: FileSystemInstallAdapterOptions = {}) {
    this.options = options;
  }

  async inspect(
    context: TransitionAdapterContext,
    signal: AbortSignal,
  ): Promise<TransitionObservation> {
    this.assertSupported(context.transition);
    throwIfAborted(signal);
    await this.fault("inspect:before", context);
    const state = await this.inspectState(context);
    await this.fault("inspect:after", context);
    throwIfAborted(signal);
    return { transitionId: context.transition.id, state };
  }

  async prepare(
    context: TransitionAdapterContext,
    observation: TransitionObservation,
    signal: AbortSignal,
  ): Promise<PreparedTransition> {
    const transition = context.transition;
    this.assertSupported(transition);
    throwIfAborted(signal);
    await this.fault("prepare:before", context);
    if (!statesEqual(observation.state, transition.baseline)) {
      throw new Error(`Transition "${transition.id}" was not prepared from its baseline.`);
    }
    await this.assertState(context, transition.baseline);

    const handle = await this.createHandle(context);
    try {
      if (transition.baseline.type === "file") {
        const targetPath = await this.assertBoundedTarget(context, true);
        handle.baselineMode = (await lstat(targetPath)).mode & 0o777;
        await copyFile(targetPath, handle.backupPath!, constants.COPYFILE_EXCL);
        await chmod(handle.backupPath!, 0o600);
        await assertFileHash(handle.backupPath!, transition.baseline.sha256);
      } else if (
        transition.baseline.type === "directory-tree" ||
        transition.baseline.type === "dependency-tree"
      ) {
        const targetPath = await this.assertBoundedTarget(context, true);
        copyFileSystemTree(targetPath, handle.backupPath!, {
          allowInternalLinks: transition.baseline.type === "dependency-tree",
        });
        await chmod(handle.backupPath!, 0o700);
        await assertTreeHash(
          handle.backupPath!,
          transition.baseline.sha256,
          transition.baseline.type === "dependency-tree",
        );
      }

      if (transition.desired.type === "file") {
        await this.stageFile(context, handle, signal);
      } else if (transition.desired.type === "dependency-tree") {
        await this.stageDependencyTree(context, handle, signal);
      }

      await this.fault("prepare:after-stage", context);
      await this.assertPreparedPostimage(context, handle);
      throwIfAborted(signal);
      return {
        transitionId: transition.id,
        postimage: structuredClone(transition.desired),
        stagingHandle: handle,
        recoveryArtifacts: handle.recoveryArtifacts,
      };
    } catch (error) {
      throw error;
    }
  }

  async apply(
    context: TransitionAdapterContext,
    prepared: PreparedTransition,
    signal: AbortSignal,
  ): Promise<TransitionReceipt> {
    const transition = context.transition;
    const handle = this.requireHandle(transition, prepared);
    throwIfAborted(signal);
    await this.fault("apply:before", context);
    await this.assertState(context, transition.baseline);
    await this.assertPreparedPostimage(context, handle);
    await this.fault("apply:before-mutation", context);
    throwIfAborted(signal);
    await this.mutate(context, handle, transition.baseline, transition.desired);
    await this.fault("apply:after-mutation", context);
    await this.assertState(context, transition.desired);
    return receipt(transition, "apply", transition.baseline, transition.desired);
  }

  async rollback(
    context: TransitionAdapterContext,
    preparedReceipt: TransitionReceipt | undefined,
    signal: AbortSignal,
  ): Promise<TransitionReceipt> {
    const transition = context.transition;
    const handle = this.handles.get(transition.id);
    if (!handle) {
      throw new Error(`Transition "${transition.id}" has no private rollback state.`);
    }
    if (
      preparedReceipt &&
      (preparedReceipt.transitionId !== transition.id || preparedReceipt.operation !== "apply")
    ) {
      throw new Error(`Transition "${transition.id}" received an invalid apply receipt.`);
    }

    throwIfAborted(signal);
    await this.fault("rollback:before", context);
    await this.assertState(context, transition.desired);
    await this.assertBackup(context, handle);
    await this.fault("rollback:before-mutation", context);
    throwIfAborted(signal);
    await this.mutate(context, handle, transition.desired, transition.baseline);
    await this.fault("rollback:after-mutation", context);
    await this.assertState(context, transition.baseline);
    return receipt(transition, "rollback", transition.desired, transition.baseline);
  }

  async cleanup(
    context: TransitionAdapterContext,
    _prepared: PreparedTransition | undefined,
    disposition: PreparedTransitionDisposition,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertSupported(context.transition);
    throwIfAborted(signal);
    await this.fault("cleanup:before", context);
    const handle = this.handles.get(context.transition.id);
    if (handle) {
      for (const artifact of [...handle.siblingArtifacts.values()]) {
        await this.removeSiblingArtifact(context, handle, artifact);
      }

      if (disposition === "residual" && handle.backupPath) {
        if (handle.stagedPath) await rm(handle.stagedPath, { force: true, recursive: true });
        if (handle.workPath) await rm(handle.workPath, { force: true, recursive: true });
      } else {
        await rm(handle.directoryPath, { force: true, recursive: true });
        this.handles.delete(context.transition.id);
      }
    }

    await this.removeEmptyWorkspace();
    await this.fault("cleanup:after", context);
  }

  private async inspectState(context: TransitionAdapterContext): Promise<ExactResourceState> {
    const transition = context.transition;
    const targetPath = await this.assertBoundedTarget(context, false);
    const info = await lstatIfPresent(targetPath);
    if (!info) return { type: "absent" };
    if (info.isSymbolicLink()) {
      throw new Error(`Transition "${transition.id}" targets a link or junction.`);
    }

    let state: ExactResourceState;
    if (transition.kind === "parent-directory") {
      if (!info.isDirectory()) {
        throw new Error(`Transition "${transition.id}" expected a directory target.`);
      }
      state = { type: "directory" };
    } else if (transition.kind === "directory-tree") {
      if (!info.isDirectory()) {
        throw new Error(`Transition "${transition.id}" expected a directory tree.`);
      }
      state = {
        type: "directory-tree",
        sha256: snapshotFileSystemTree(targetPath).sha256,
      };
    } else if (transition.kind === "dependency-tree") {
      if (!info.isDirectory()) {
        throw new Error(`Transition "${transition.id}" expected a dependency tree.`);
      }
      state = {
        type: "dependency-tree",
        sha256: snapshotFileSystemTree(targetPath, { allowInternalLinks: true }).sha256,
      };
    } else {
      if (!info.isFile()) {
        throw new Error(`Transition "${transition.id}" expected a file target.`);
      }
      state = { type: "file", sha256: await hashFile(targetPath) };
    }

    await this.assertBoundedTarget(context, true);
    return state;
  }

  private async createHandle(
    context: TransitionAdapterContext,
  ): Promise<FileSystemPreparedHandle> {
    if (this.handles.has(context.transition.id)) {
      throw new Error(`Transition "${context.transition.id}" was prepared more than once.`);
    }
    const workspacePath = await this.ensureWorkspace(context);
    const directoryPath = path.join(workspacePath, randomUUID());
    await mkdir(directoryPath, { mode: 0o700 });
    await chmod(directoryPath, 0o700);
    const hasBaseline = context.transition.baseline.type !== "absent" &&
      context.transition.baseline.type !== "directory";
    const backupPath = hasBaseline ? path.join(directoryPath, "baseline") : undefined;
    const stagedPath = context.transition.desired.type === "file" ||
        context.transition.desired.type === "dependency-tree"
      ? path.join(directoryPath, "staged")
      : undefined;
    const workPath = context.transition.desired.type === "dependency-tree"
      ? path.join(directoryPath, "dependency-work")
      : undefined;
    const handle: FileSystemPreparedHandle = {
      token: Symbol(context.transition.id),
      transitionId: context.transition.id,
      directoryPath,
      stagedPath,
      backupPath,
      workPath,
      recoveryArtifacts: backupPath ? Object.freeze([backupPath]) : Object.freeze([]),
      siblingArtifacts: new Map(),
    };
    this.handles.set(context.transition.id, handle);
    return handle;
  }

  private async ensureWorkspace(context: TransitionAdapterContext): Promise<string> {
    if (this.workspacePath) return this.workspacePath;
    const temporaryRoot = path.resolve(this.options.temporaryRoot ?? tmpdir());
    const temporaryInfo = await lstat(temporaryRoot);
    if (!temporaryInfo.isDirectory() || temporaryInfo.isSymbolicLink()) {
      throw new Error(`Install transaction temporary root is not a physical directory: ${temporaryRoot}`);
    }
    const temporaryRealPath = await realpath(temporaryRoot);
    const checkoutRealPath = await realpath(context.plan.checkoutRoot);
    if (isPathInside(checkoutRealPath, temporaryRealPath)) {
      throw new Error("Install transaction storage must be outside checkout content.");
    }
    for (const resourceRoot of context.plan.resourceRoots) {
      const resourceRealPath = await realpath(resourceRoot);
      if (isPathInside(resourceRealPath, temporaryRealPath)) {
        throw new Error("Install transaction storage must be outside live resource roots.");
      }
    }
    const workspacePath = await mkdtemp(path.join(temporaryRoot, "workflow-install-"));
    await chmod(workspacePath, 0o700);
    this.workspacePath = workspacePath;
    return workspacePath;
  }

  private async stageFile(
    context: TransitionAdapterContext,
    handle: FileSystemPreparedHandle,
    signal: AbortSignal,
  ): Promise<void> {
    const transition = context.transition;
    if (transition.desired.type !== "file" || !handle.stagedPath) return;
    let content: Buffer;
    let mode = 0o600;
    if (transition.kind === "file") {
      if (transition.stage.type !== "source-file") {
        throw new Error(`File transition "${transition.id}" has no source payload.`);
      }
      const sourceContext: TransitionAdapterContext = {
        plan: context.plan,
        transition: {
          ...transition,
          target: {
            root: transition.stage.checkoutRoot,
            relativePath: transition.stage.sourcePath,
          },
        },
      };
      const sourcePath = await this.assertBoundedTarget(sourceContext, true);
      const sourceInfo = await lstat(sourcePath);
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
        throw new Error(`Payload source is not a physical file: ${transition.stage.sourcePath}`);
      }
      content = await readFile(sourcePath);
      mode = sourceInfo.mode & 0o777;
      await this.assertBoundedTarget(sourceContext, true);
      if (hashBytes(content) !== transition.stage.sha256) {
        throw new Error(`Payload source changed before staging: ${transition.stage.sourcePath}`);
      }
    } else if (
      transition.kind === "ownership-manifest" &&
      transition.stage.type === "generated-json"
    ) {
      content = Buffer.from(`${JSON.stringify(transition.stage.value, null, 2)}\n`, "utf8");
    } else if (
      transition.kind === "restore-data" &&
      transition.stage.type === "private-generated-json"
    ) {
      content = Buffer.from(`${JSON.stringify(transition.stage.value, null, 2)}\n`, "utf8");
    } else {
      throw new Error(`Transition "${transition.id}" has no file staging input.`);
    }

    throwIfAborted(signal);
    await writeFile(handle.stagedPath, content, { flag: "wx", mode: 0o600 });
    await chmod(handle.stagedPath, 0o600);
    handle.stagedMode = transition.kind === "restore-data" ? 0o600 : mode;
    await assertFileHash(handle.stagedPath, transition.desired.sha256);
  }

  private async stageDependencyTree(
    context: TransitionAdapterContext,
    handle: FileSystemPreparedHandle,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      context.transition.kind !== "dependency-tree" ||
      context.transition.desired.type !== "dependency-tree" ||
      !handle.stagedPath ||
      !handle.workPath
    ) {
      return;
    }
    const request: DependencyTreePrepareRequest = {
      context: context as DependencyTreePrepareRequest["context"],
      outputPath: handle.stagedPath,
      workPath: handle.workPath,
      signal,
    };
    await (this.options.prepareDependencyTree ?? defaultPrepareDependencyTree)(request);
    throwIfAborted(signal);
    await assertTreeHash(handle.stagedPath, context.transition.desired.sha256, true);
  }

  private async assertPreparedPostimage(
    context: TransitionAdapterContext,
    handle: FileSystemPreparedHandle,
  ): Promise<void> {
    const desired = context.transition.desired;
    if (desired.type === "file") {
      if (!handle.stagedPath) throw new Error("Prepared file staging is missing.");
      await assertPrivatePath(handle.directoryPath, handle.stagedPath);
      await assertFileHash(handle.stagedPath, desired.sha256);
    } else if (desired.type === "dependency-tree") {
      if (!handle.stagedPath) throw new Error("Prepared dependency staging is missing.");
      await assertPrivatePath(handle.directoryPath, handle.stagedPath);
      await assertTreeHash(handle.stagedPath, desired.sha256, true);
    }
  }

  private async assertBackup(
    context: TransitionAdapterContext,
    handle: FileSystemPreparedHandle,
  ): Promise<void> {
    const baseline = context.transition.baseline;
    if (baseline.type === "absent" || baseline.type === "directory") return;
    if (!handle.backupPath) {
      throw new Error(`Transition "${context.transition.id}" has no private backup.`);
    }
    await assertPrivatePath(handle.directoryPath, handle.backupPath);
    if (baseline.type === "file") {
      await assertFileHash(handle.backupPath, baseline.sha256);
    } else {
      await assertTreeHash(
        handle.backupPath,
        baseline.sha256,
        baseline.type === "dependency-tree",
      );
    }
  }

  private async mutate(
    context: TransitionAdapterContext,
    handle: FileSystemPreparedHandle,
    expected: ResourcePostimage,
    desired: ResourcePostimage,
  ): Promise<void> {
    if (expected.type === "opaque" || desired.type === "opaque") {
      throw new Error("Opaque resources require a format-specific adapter.");
    }
    if (desired.type === "directory") {
      const targetPath = await this.assertBoundedTarget(context, true);
      await this.assertState(context, expected);
      await mkdir(targetPath, { mode: 0o700, recursive: false });
      return;
    }

    if (desired.type === "absent") {
      if (expected.type === "absent") return;
      if (expected.type === "directory") {
        const targetPath = await this.assertBoundedTarget(context, true);
        await this.assertState(context, expected);
        await rmdir(targetPath);
      } else if (expected.type === "file") {
        await this.removeFileTarget(context, handle, expected);
      } else {
        await this.removeTreeTarget(context, handle, expected);
      }
      return;
    }

    if (desired.type === "file") {
      const sourcePath = statesEqual(desired, context.transition.desired)
        ? handle.stagedPath
        : handle.backupPath;
      if (!sourcePath) throw new Error("File mutation source is unavailable.");
      await this.installFileTarget(context, handle, sourcePath, expected, desired);
      return;
    }

    const sourcePath = statesEqual(desired, context.transition.desired)
      ? handle.stagedPath
      : handle.backupPath;
    if (!sourcePath) throw new Error("Tree mutation source is unavailable.");
    await this.installTreeTarget(context, handle, sourcePath, expected, desired);
  }

  private async installFileTarget(
    context: TransitionAdapterContext,
    handle: FileSystemPreparedHandle,
    sourcePath: string,
    expected: ExactResourceState,
    desired: Extract<ExactResourceState, { type: "file" }>,
  ): Promise<void> {
    await assertFileHash(sourcePath, desired.sha256);
    const targetPath = await this.assertBoundedTarget(context, true);
    const temporaryPath = siblingPath(targetPath, "new");
    await copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL);
    const mode = statesEqual(desired, context.transition.desired)
      ? handle.stagedMode
      : handle.baselineMode;
    if (mode !== undefined) await chmod(temporaryPath, mode);
    this.trackSibling(handle, temporaryPath, desired);
    await assertFileHash(temporaryPath, desired.sha256);
    await this.assertState(context, expected);

    let displacedPath: string | undefined;
    if (expected.type === "file") {
      displacedPath = siblingPath(targetPath, "old");
      await rename(targetPath, displacedPath);
      this.trackSibling(handle, displacedPath, expected);
      try {
        await assertFileHash(displacedPath, expected.sha256);
      } catch (error) {
        await this.restoreMovedTarget(targetPath, displacedPath, handle);
        throw error;
      }
    } else if (expected.type !== "absent") {
      throw new Error("File replacement expected an incompatible resource.");
    }

    try {
      await link(temporaryPath, targetPath);
    } catch (error) {
      if (displacedPath) await this.restoreMovedTarget(targetPath, displacedPath, handle);
      throw error;
    }
    await unlink(temporaryPath);
    handle.siblingArtifacts.delete(temporaryPath);
    if (displacedPath) {
      await this.removeSiblingArtifact(
        context,
        handle,
        handle.siblingArtifacts.get(displacedPath)!,
      );
    }
  }

  private async removeFileTarget(
    context: TransitionAdapterContext,
    handle: FileSystemPreparedHandle,
    expected: Extract<ExactResourceState, { type: "file" }>,
  ): Promise<void> {
    const targetPath = await this.assertBoundedTarget(context, true);
    await this.assertState(context, expected);
    const removedPath = siblingPath(targetPath, "removed");
    await rename(targetPath, removedPath);
    this.trackSibling(handle, removedPath, expected);
    try {
      await assertFileHash(removedPath, expected.sha256);
    } catch (error) {
      await this.restoreMovedTarget(targetPath, removedPath, handle);
      throw error;
    }
    await this.removeSiblingArtifact(
      context,
      handle,
      handle.siblingArtifacts.get(removedPath)!,
    );
  }

  private async installTreeTarget(
    context: TransitionAdapterContext,
    handle: FileSystemPreparedHandle,
    sourcePath: string,
    expected: ExactResourceState,
    desired: Extract<ExactResourceState, { type: "directory-tree" | "dependency-tree" }>,
  ): Promise<void> {
    const allowLinks = desired.type === "dependency-tree";
    const sourceSnapshot = snapshotFileSystemTree(sourcePath, {
      allowInternalLinks: allowLinks,
    });
    if (sourceSnapshot.sha256 !== desired.sha256) {
      throw new Error("Tree mutation source no longer matches its planned fingerprint.");
    }
    const targetPath = await this.assertBoundedTarget(context, true);
    await this.assertState(context, expected);

    if (sourceSnapshot.containsLinks) {
      if (expected.type !== "absent") {
        await this.removeTreeInPlace(context, expected);
      }
      copyFileSystemTree(sourcePath, targetPath, { allowInternalLinks: true });
      return;
    }

    const temporaryPath = siblingPath(targetPath, "new");
    copyFileSystemTree(sourcePath, temporaryPath, { allowInternalLinks: allowLinks });
    this.trackSibling(handle, temporaryPath, desired);
    let displacedPath: string | undefined;
    if (expected.type === "directory-tree" || expected.type === "dependency-tree") {
      displacedPath = siblingPath(targetPath, "old");
      await rename(targetPath, displacedPath);
      this.trackSibling(handle, displacedPath, expected);
      try {
        await assertTreeHash(
          displacedPath,
          expected.sha256,
          expected.type === "dependency-tree",
        );
      } catch (error) {
        await this.restoreMovedTarget(targetPath, displacedPath, handle);
        throw error;
      }
    } else if (expected.type !== "absent") {
      throw new Error("Tree replacement expected an incompatible resource.");
    }

    try {
      await rename(temporaryPath, targetPath);
      handle.siblingArtifacts.delete(temporaryPath);
    } catch (error) {
      if (displacedPath) await this.restoreMovedTarget(targetPath, displacedPath, handle);
      throw error;
    }
    if (displacedPath) {
      await this.removeSiblingArtifact(
        context,
        handle,
        handle.siblingArtifacts.get(displacedPath)!,
      );
    }
  }

  private async removeTreeTarget(
    context: TransitionAdapterContext,
    handle: FileSystemPreparedHandle,
    expected: Extract<ExactResourceState, { type: "directory-tree" | "dependency-tree" }>,
  ): Promise<void> {
    const snapshot = snapshotFileSystemTree(
      await this.assertBoundedTarget(context, true),
      { allowInternalLinks: expected.type === "dependency-tree" },
    );
    if (snapshot.containsLinks) {
      await this.removeTreeInPlace(context, expected);
      return;
    }
    const targetPath = await this.assertBoundedTarget(context, true);
    await this.assertState(context, expected);
    const removedPath = siblingPath(targetPath, "removed");
    await rename(targetPath, removedPath);
    this.trackSibling(handle, removedPath, expected);
    try {
      await assertTreeHash(
        removedPath,
        expected.sha256,
        expected.type === "dependency-tree",
      );
    } catch (error) {
      await this.restoreMovedTarget(targetPath, removedPath, handle);
      throw error;
    }
    await this.removeSiblingArtifact(
      context,
      handle,
      handle.siblingArtifacts.get(removedPath)!,
    );
  }

  private async removeTreeInPlace(
    context: TransitionAdapterContext,
    expected: Extract<ExactResourceState, { type: "directory-tree" | "dependency-tree" }>,
  ): Promise<void> {
    const targetPath = await this.assertBoundedTarget(context, true);
    await this.assertState(context, expected);
    removeFileSystemTree(targetPath);
  }

  private async restoreMovedTarget(
    targetPath: string,
    movedPath: string,
    handle: FileSystemPreparedHandle,
  ): Promise<void> {
    if (await lstatIfPresent(targetPath)) return;
    await rename(movedPath, targetPath);
    handle.siblingArtifacts.delete(movedPath);
  }

  private trackSibling(
    handle: FileSystemPreparedHandle,
    artifactPath: string,
    state: ExactResourceState,
  ): void {
    handle.siblingArtifacts.set(artifactPath, {
      path: artifactPath,
      state: structuredClone(state),
    });
  }

  private async removeSiblingArtifact(
    context: TransitionAdapterContext,
    handle: FileSystemPreparedHandle,
    artifact: SiblingArtifact,
  ): Promise<void> {
    const targetPath = resolveTargetPath(context.transition);
    if (
      path.dirname(artifact.path) !== path.dirname(targetPath) ||
      !path.basename(artifact.path).startsWith(`.${path.basename(targetPath)}.workflow-install-`)
    ) {
      throw new Error("Refusing to clean an unbounded sibling artifact.");
    }
    const state = await inspectArtifact(artifact.path, artifact.state.type);
    if (state.type === "absent") {
      handle.siblingArtifacts.delete(artifact.path);
      return;
    }
    if (!statesEqual(state, artifact.state)) {
      throw new Error(`Transaction sibling artifact changed before cleanup: ${artifact.path}`);
    }
    if (state.type === "file") await unlink(artifact.path);
    else if (state.type === "directory-tree" || state.type === "dependency-tree") {
      removeFileSystemTree(artifact.path);
    } else {
      throw new Error(`Unsupported sibling artifact state: ${artifact.path}`);
    }
    handle.siblingArtifacts.delete(artifact.path);
  }

  private async assertState(
    context: TransitionAdapterContext,
    expected: ResourcePostimage,
  ): Promise<void> {
    if (expected.type === "opaque") {
      throw new Error("Opaque resources require a format-specific adapter.");
    }
    const observed = await this.inspectState(context);
    if (!statesEqual(observed, expected)) {
      throw new Error(`Transition "${context.transition.id}" changed at its mutation boundary.`);
    }
  }

  private async assertBoundedTarget(
    context: TransitionAdapterContext,
    requireParent: boolean,
  ): Promise<string> {
    const { root, relativePath } = context.transition.target;
    if (!path.isAbsolute(root) || path.resolve(root) !== root) {
      throw new Error(`Transition "${context.transition.id}" has a non-canonical root.`);
    }
    const components = relativePath.split("/");
    if (
      relativePath.length === 0 ||
      components.some(
        (component) =>
          component.length === 0 || component === "." || component === ".." ||
          component.includes("\\") || component.toLowerCase() === ".workflow",
      )
    ) {
      throw new Error(`Transition "${context.transition.id}" has an unsafe target path.`);
    }
    const targetPath = path.resolve(root, ...components);
    if (!samePath(targetPath, resolveTargetPath(context.transition))) {
      throw new Error(`Transition "${context.transition.id}" escapes its resource root.`);
    }

    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error(`Transition root was replaced by a link or non-directory: ${root}`);
    }
    const rootRealPath = await realpath(root);
    const previous = this.roots.get(nativeKey(root));
    if (previous) {
      if (
        previous.dev !== rootInfo.dev || previous.ino !== rootInfo.ino ||
        !samePath(previous.realPath, rootRealPath)
      ) {
        throw new Error(`Transition root changed after planning: ${root}`);
      }
    } else {
      this.roots.set(nativeKey(root), {
        realPath: rootRealPath,
        dev: rootInfo.dev,
        ino: rootInfo.ino,
      });
    }

    let currentPath = root;
    for (const [index, component] of components.entries()) {
      currentPath = path.join(currentPath, component);
      const info = await lstatIfPresent(currentPath);
      if (!info) {
        if (requireParent && index < components.length - 1) {
          throw new Error(`Transition parent directory is missing: ${currentPath}`);
        }
        break;
      }
      if (info.isSymbolicLink()) {
        throw new Error(`Transition path contains a link or junction: ${currentPath}`);
      }
      if (index < components.length - 1 && !info.isDirectory()) {
        throw new Error(`Transition path has a non-directory parent: ${currentPath}`);
      }
      const currentRealPath = await realpath(currentPath);
      if (!isPathInside(rootRealPath, currentRealPath)) {
        throw new Error(`Transition path escapes its real resource root: ${currentPath}`);
      }
    }
    return targetPath;
  }

  private requireHandle(
    transition: InstallTransition,
    prepared: PreparedTransition,
  ): FileSystemPreparedHandle {
    const handle = this.handles.get(transition.id);
    if (
      !handle || prepared.transitionId !== transition.id ||
      prepared.stagingHandle !== handle
    ) {
      throw new Error(`Transition "${transition.id}" received unknown staged output.`);
    }
    return handle;
  }

  private assertSupported(transition: InstallTransition): void {
    if (transition.kind === "opaque-registration" || transition.kind === "external-registration") {
      throw new Error(
        `Transition "${transition.id}" requires its dedicated registration adapter.`,
      );
    }
  }

  private async removeEmptyWorkspace(): Promise<void> {
    if (!this.workspacePath) return;
    try {
      await rmdir(this.workspacePath);
      this.workspacePath = undefined;
    } catch (error) {
      if (!hasCode(error, "ENOTEMPTY") && !hasCode(error, "ENOENT")) throw error;
      if (hasCode(error, "ENOENT")) this.workspacePath = undefined;
    }
  }

  private async fault(
    boundary: FileSystemInstallBoundary,
    context: TransitionAdapterContext,
  ): Promise<void> {
    await this.options.injectFault?.({ boundary, context });
  }
}

async function defaultPrepareDependencyTree(
  request: DependencyTreePrepareRequest,
): Promise<void> {
  const { transition } = request.context;
  if (transition.stage.type !== "dependency-prepare") {
    throw new Error(`Dependency transition "${transition.id}" has no package policy.`);
  }
  await mkdir(request.workPath, { mode: 0o700 });
  await chmod(request.workPath, 0o700);

  let command: readonly string[];
  if (transition.stage.lockfilePath) {
    const packageRelativePath = [
      ...transition.stage.lockfilePath.split("/").slice(0, -1),
      "package.json",
    ].join("/");
    const [lockfile, packageFile] = await Promise.all([
      readBoundedFile(request.context.plan.checkoutRoot, transition.stage.lockfilePath),
      readBoundedFile(request.context.plan.checkoutRoot, packageRelativePath),
    ]);
    await Promise.all([
      writeFile(path.join(request.workPath, "package-lock.json"), lockfile, {
        mode: 0o600,
      }),
      writeFile(path.join(request.workPath, "package.json"), packageFile, {
        mode: 0o600,
      }),
    ]);
    command = ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev"];
  } else {
    const dependencies = Object.fromEntries(
      transition.stage.packageNames.map((packageName) => [packageName, "*"]),
    );
    await writeFile(
      path.join(request.workPath, "package.json"),
      `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`,
      { mode: 0o600 },
    );
    command = ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"];
  }

  await runCommand(
    process.platform === "win32" ? "npm.cmd" : "npm",
    command,
    request.workPath,
    request.signal,
  );
  const nodeModulesPath = path.join(request.workPath, "node_modules");
  await rename(nodeModulesPath, request.outputPath);
}

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) {
        reject(abortError(signal));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`npm dependency staging failed with exit code ${code}: ${stderr.trim()}`));
      }
    });
  });
}

async function readBoundedFile(rootPath: string, relativePath: string): Promise<Buffer> {
  const rootInfo = await lstat(rootPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Dependency staging root is not a physical directory: ${rootPath}`);
  }
  const rootRealPath = await realpath(rootPath);
  let candidatePath = rootPath;
  for (const component of relativePath.split("/")) {
    if (
      !component || component === "." || component === ".." ||
      component.includes("\\") || component.toLowerCase() === ".workflow"
    ) {
      throw new Error(`Dependency staging path is unsafe: ${relativePath}`);
    }
    candidatePath = path.join(candidatePath, component);
    const info = await lstat(candidatePath);
    if (info.isSymbolicLink()) {
      throw new Error(`Dependency staging path contains a link: ${relativePath}`);
    }
  }
  const info = await lstat(candidatePath);
  const candidateRealPath = await realpath(candidatePath);
  if (!info.isFile() || !isPathInside(rootRealPath, candidateRealPath)) {
    throw new Error(`Dependency staging file escapes its checkout root: ${relativePath}`);
  }
  const content = await readFile(candidatePath);
  const after = await lstat(candidatePath);
  const rootAfter = await lstat(rootPath);
  const rootRealPathAfter = await realpath(rootPath);
  if (
    info.dev !== after.dev || info.ino !== after.ino ||
    info.size !== after.size || info.mtimeMs !== after.mtimeMs ||
    rootInfo.dev !== rootAfter.dev || rootInfo.ino !== rootAfter.ino ||
    !samePath(rootRealPath, rootRealPathAfter)
  ) {
    throw new Error(`Dependency staging file changed while reading: ${relativePath}`);
  }
  return content;
}

function receipt(
  transition: InstallTransition,
  operation: TransitionReceipt["operation"],
  before: ResourcePostimage,
  after: ResourcePostimage,
): TransitionReceipt {
  return {
    transitionId: transition.id,
    operation,
    before: structuredClone(before),
    after: structuredClone(after),
  };
}

async function inspectArtifact(
  artifactPath: string,
  expectedType: ExactResourceState["type"],
): Promise<ExactResourceState> {
  const info = await lstatIfPresent(artifactPath);
  if (!info) return { type: "absent" };
  if (info.isSymbolicLink()) throw new Error(`Transaction artifact became a link: ${artifactPath}`);
  if (expectedType === "file") {
    if (!info.isFile()) throw new Error(`Transaction file artifact changed kind: ${artifactPath}`);
    return { type: "file", sha256: await hashFile(artifactPath) };
  }
  if (expectedType === "directory-tree" || expectedType === "dependency-tree") {
    if (!info.isDirectory()) throw new Error(`Transaction tree artifact changed kind: ${artifactPath}`);
    return {
      type: expectedType,
      sha256: snapshotFileSystemTree(artifactPath, {
        allowInternalLinks: expectedType === "dependency-tree",
      }).sha256,
    };
  }
  throw new Error(`Unsupported transaction sibling artifact: ${artifactPath}`);
}

async function assertPrivatePath(rootPath: string, candidatePath: string): Promise<void> {
  const rootRealPath = await realpath(rootPath);
  const candidateInfo = await lstat(candidatePath);
  if (candidateInfo.isSymbolicLink()) {
    throw new Error(`Private transaction artifact became a link: ${candidatePath}`);
  }
  const candidateRealPath = await realpath(candidatePath);
  if (!isPathInside(rootRealPath, candidateRealPath)) {
    throw new Error(`Private transaction artifact escaped its root: ${candidatePath}`);
  }
}

async function assertFileHash(filePath: string, expectedHash: string): Promise<void> {
  const actualHash = await hashFile(filePath);
  if (actualHash !== expectedHash) {
    throw new Error(`File fingerprint mismatch: ${filePath}`);
  }
}

async function assertTreeHash(
  treePath: string,
  expectedHash: string,
  allowInternalLinks: boolean,
): Promise<void> {
  const actualHash = snapshotFileSystemTree(treePath, { allowInternalLinks }).sha256;
  if (actualHash !== expectedHash) {
    throw new Error(`Tree fingerprint mismatch: ${treePath}`);
  }
}

async function hashFile(filePath: string): Promise<string> {
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Cannot fingerprint a non-file resource: ${filePath}`);
  }
  const content = await readFile(filePath);
  const after = await lstat(filePath);
  if (
    before.dev !== after.dev || before.ino !== after.ino ||
    before.size !== after.size || before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error(`File changed while it was being fingerprinted: ${filePath}`);
  }
  return hashBytes(content);
}

function hashBytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function lstatIfPresent(filePath: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function resolveTargetPath(transition: InstallTransition): string {
  return path.resolve(
    transition.target.root,
    ...transition.target.relativePath.split("/"),
  );
}

function siblingPath(targetPath: string, purpose: string): string {
  return path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.workflow-install-${purpose}-${randomUUID()}`,
  );
}

function statesEqual(left: ResourcePostimage, right: ResourcePostimage): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "opaque" || right.type === "opaque") return false;
  if (left.type === "file" && right.type === "file") return left.sha256 === right.sha256;
  if (
    left.type === "directory-tree" && right.type === "directory-tree" ||
    left.type === "dependency-tree" && right.type === "dependency-tree"
  ) {
    return left.sha256 === right.sha256;
  }
  return true;
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === "" || (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function samePath(left: string, right: string): boolean {
  return nativeKey(left) === nativeKey(right);
}

function nativeKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as { code?: unknown }).code === code;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    signal.reason === undefined ? "The install operation was cancelled." : String(signal.reason),
  );
  error.name = "AbortError";
  return error;
}
