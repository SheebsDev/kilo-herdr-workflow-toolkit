import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import * as path from "node:path";

export interface FileSystemTreeEntry {
  readonly path: string;
  readonly kind: "file" | "directory" | "link";
  readonly sha256: string;
  readonly linkTarget?: string;
}

export interface FileSystemTreeSnapshot {
  readonly sha256: string;
  readonly entries: readonly FileSystemTreeEntry[];
  readonly containsLinks: boolean;
}

export interface FileSystemTreeOptions {
  readonly allowInternalLinks?: boolean;
}

export function snapshotFileSystemTree(
  directoryPath: string,
  options: FileSystemTreeOptions = {},
): FileSystemTreeSnapshot {
  const rootInfo = lstatSync(directoryPath);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`Tree root is not a physical directory: ${directoryPath}`);
  }

  const rootRealPath = realpathSync.native(directoryPath);
  const hash = createHash("sha256");
  const snapshotEntries: FileSystemTreeEntry[] = [];
  let containsLinks = false;

  const visit = (currentPath: string, relativePath: string): void => {
    const entries = readdirSync(currentPath, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    for (const entry of entries) {
      const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const childPath = path.join(currentPath, entry.name);
      const childInfo = lstatSync(childPath);

      if (childInfo.isSymbolicLink()) {
        if (!options.allowInternalLinks) {
          throw new Error(`Tree contains a link: ${childRelativePath}`);
        }
        const link = inspectInternalLink(
          directoryPath,
          rootRealPath,
          childPath,
          childRelativePath,
        );
        containsLinks = true;
        hash.update(`L:${childRelativePath}:${link.target}:${link.kind}`, "utf8");
        snapshotEntries.push({
          path: childRelativePath,
          kind: "link",
          sha256: createHash("sha256")
            .update(`${link.target}\0${link.kind}`, "utf8")
            .digest("hex"),
          linkTarget: link.target,
        });
        continue;
      }

      if (childInfo.isDirectory()) {
        hash.update(`D:${childRelativePath}`, "utf8");
        snapshotEntries.push({
          path: childRelativePath,
          kind: "directory",
          sha256: createHash("sha256").update(childRelativePath, "utf8").digest("hex"),
        });
        visit(childPath, childRelativePath);
        continue;
      }

      if (childInfo.isFile()) {
        const content = readFileSync(childPath);
        const sha256 = createHash("sha256").update(content).digest("hex");
        hash.update(`F:${childRelativePath}`, "utf8");
        hash.update(content);
        snapshotEntries.push({
          path: childRelativePath,
          kind: "file",
          sha256,
        });
        continue;
      }

      throw new Error(`Tree contains an unsupported entry: ${childRelativePath}`);
    }
  };

  visit(directoryPath, "");
  return {
    sha256: hash.digest("hex"),
    entries: snapshotEntries,
    containsLinks,
  };
}

export function copyFileSystemTree(
  sourcePath: string,
  destinationPath: string,
  options: FileSystemTreeOptions = {},
): FileSystemTreeSnapshot {
  const sourceSnapshot = snapshotFileSystemTree(sourcePath, options);
  const sourceRootInfo = lstatSync(sourcePath);
  mkdirSync(destinationPath, {
    mode: sourceRootInfo.mode & 0o777,
    recursive: false,
  });

  const links: Array<{
    destinationPath: string;
    targetRelativePath: string;
    kind: "file" | "directory";
  }> = [];

  const visit = (currentSource: string, currentDestination: string): void => {
    const entries = readdirSync(currentSource, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    for (const entry of entries) {
      const sourceChild = path.join(currentSource, entry.name);
      const destinationChild = path.join(currentDestination, entry.name);
      const childInfo = lstatSync(sourceChild);
      if (childInfo.isSymbolicLink()) {
        if (!options.allowInternalLinks) {
          throw new Error(`Tree contains a link: ${sourceChild}`);
        }
        const relativeSource = toPortablePath(path.relative(sourcePath, sourceChild));
        const link = inspectInternalLink(
          sourcePath,
          realpathSync.native(sourcePath),
          sourceChild,
          relativeSource,
        );
        links.push({
          destinationPath: destinationChild,
          targetRelativePath: link.target,
          kind: link.kind,
        });
      } else if (childInfo.isDirectory()) {
        mkdirSync(destinationChild, {
          mode: childInfo.mode & 0o777,
          recursive: false,
        });
        visit(sourceChild, destinationChild);
      } else if (childInfo.isFile()) {
        copyFileSync(sourceChild, destinationChild, constants.COPYFILE_EXCL);
        chmodSync(destinationChild, childInfo.mode & 0o777);
      } else {
        throw new Error(`Tree contains an unsupported entry: ${sourceChild}`);
      }
    }
  };

  try {
    visit(sourcePath, destinationPath);
    for (const link of links) {
      const destinationTarget = path.resolve(
        destinationPath,
        ...link.targetRelativePath.split("/"),
      );
      const linkTarget = process.platform === "win32" && link.kind === "directory"
        ? destinationTarget
        : path.relative(path.dirname(link.destinationPath), destinationTarget) || ".";
      symlinkSync(
        linkTarget,
        link.destinationPath,
        process.platform === "win32" && link.kind === "directory"
          ? "junction"
          : link.kind === "directory" ? "dir" : "file",
      );
    }

    const copiedSnapshot = snapshotFileSystemTree(destinationPath, options);
    if (copiedSnapshot.sha256 !== sourceSnapshot.sha256) {
      throw new Error(`Copied tree fingerprint does not match its source: ${destinationPath}`);
    }
    return copiedSnapshot;
  } catch (error) {
    try {
      removeFileSystemTree(destinationPath);
    } catch {
      // Preserve the copy error; callers retain or report any failed cleanup.
    }
    throw error;
  }
}

/** Recursively removes a tree without following symbolic links or junctions. */
export function removeFileSystemTree(directoryPath: string): void {
  const info = lstatSync(directoryPath);
  if (info.isSymbolicLink()) {
    unlinkSync(directoryPath);
    return;
  }
  if (!info.isDirectory()) {
    throw new Error(`Tree root is not a directory: ${directoryPath}`);
  }

  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    const childPath = path.join(directoryPath, entry.name);
    const childInfo = lstatSync(childPath);
    if (childInfo.isSymbolicLink() || childInfo.isFile()) {
      unlinkSync(childPath);
    } else if (childInfo.isDirectory()) {
      removeFileSystemTree(childPath);
    } else {
      throw new Error(`Tree contains an unsupported entry: ${childPath}`);
    }
  }
  rmdirSync(directoryPath);
}

function inspectInternalLink(
  rootPath: string,
  rootRealPath: string,
  linkPath: string,
  relativePath: string,
): { target: string; kind: "file" | "directory" } {
  const rawTarget = readlinkSync(linkPath);
  const resolvedTarget = path.resolve(path.dirname(linkPath), rawTarget);
  const targetRelativePath = path.relative(rootPath, resolvedTarget);
  if (
    targetRelativePath === "" ||
    targetRelativePath === ".." ||
    targetRelativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(targetRelativePath)
  ) {
    throw new Error(`Tree link escapes its owned root: ${relativePath}`);
  }

  let targetRealPath: string;
  try {
    targetRealPath = realpathSync.native(resolvedTarget);
  } catch (error) {
    throw new Error(`Tree link cannot be resolved safely: ${relativePath}`, { cause: error });
  }
  if (!isPathInside(rootRealPath, targetRealPath)) {
    throw new Error(`Tree link escapes its owned root: ${relativePath}`);
  }

  const targetInfo = statSync(resolvedTarget);
  if (!targetInfo.isFile() && !targetInfo.isDirectory()) {
    throw new Error(`Tree link targets an unsupported entry: ${relativePath}`);
  }
  return {
    target: toPortablePath(targetRelativePath),
    kind: targetInfo.isDirectory() ? "directory" : "file",
  };
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === "" || (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function toPortablePath(value: string): string {
  return value.split(path.sep).join("/");
}
