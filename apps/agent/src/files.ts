import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  open,
  rename,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  assertWorkspaceWritable,
  resolveExistingWorkspacePath,
  resolveWritableWorkspacePath,
  type WorkspaceReference,
} from "./security.js";

export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

export function contentHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export class FileConflictError extends Error {
  readonly code = "FILE_CONFLICT";

  constructor(
    readonly expectedHash: string,
    readonly actualHash: string,
  ) {
    super("The file changed on disk after it was opened.");
    this.name = "FileConflictError";
  }
}

export class FileTooLargeError extends Error {
  readonly code = "FILE_TOO_LARGE";

  constructor(
    readonly sizeBytes: number,
    readonly maxBytes = MAX_TEXT_FILE_BYTES,
  ) {
    super(`Text files are limited to ${maxBytes} bytes.`);
    this.name = "FileTooLargeError";
  }
}

export class InvalidTextFileError extends Error {
  readonly code = "INVALID_TEXT_FILE";

  constructor(message: string) {
    super(message);
    this.name = "InvalidTextFileError";
  }
}

export class FileChangedDuringReadError extends Error {
  readonly code = "FILE_CHANGED_DURING_READ";

  constructor() {
    super("The file changed on disk while it was being read.");
    this.name = "FileChangedDuringReadError";
  }
}

export interface BoundedWorkspaceFile {
  absolutePath: string;
  buffer: Buffer;
  sizeBytes: number;
  mtimeMs: number;
  mode: number;
}

export interface ReadTextResult {
  relativePath: string;
  content: string;
  contentHash: string;
  sizeBytes: number;
  mtimeMs: number;
}

export async function readBoundedWorkspaceFile(
  workspace: WorkspaceReference,
  relativePath: string,
  maxBytes: number,
): Promise<BoundedWorkspaceFile> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes > MAX_TEXT_FILE_BYTES
  ) {
    throw new RangeError(
      `The file byte limit must be between 0 and ${MAX_TEXT_FILE_BYTES}.`,
    );
  }

  const absolutePath = await resolveExistingWorkspacePath(workspace, relativePath);
  let handle: FileHandle;
  try {
    handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new FileChangedDuringReadError();
    }
    throw error;
  }

  try {
    const initialInfo = await handle.stat();
    if (!initialInfo.isFile()) {
      throw new Error("The requested path is not a file.");
    }
    if (initialInfo.size > maxBytes) {
      throw new FileTooLargeError(initialInfo.size, maxBytes);
    }

    const revalidatedPath = await resolveExistingWorkspacePath(
      workspace,
      relativePath,
    );
    const pathInfo = await stat(revalidatedPath);
    if (
      revalidatedPath !== absolutePath ||
      pathInfo.dev !== initialInfo.dev ||
      pathInfo.ino !== initialInfo.ino
    ) {
      throw new FileChangedDuringReadError();
    }

    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      throw new FileTooLargeError(offset, maxBytes);
    }

    const finalInfo = await handle.stat();
    if (
      finalInfo.size !== initialInfo.size ||
      finalInfo.mtimeMs !== initialInfo.mtimeMs ||
      finalInfo.ctimeMs !== initialInfo.ctimeMs
    ) {
      throw new FileChangedDuringReadError();
    }
    return {
      absolutePath,
      buffer: buffer.subarray(0, offset),
      sizeBytes: offset,
      mtimeMs: finalInfo.mtimeMs,
      mode: finalInfo.mode,
    };
  } finally {
    await handle.close();
  }
}

export function decodeUtf8Text(buffer: Buffer): string {
  if (buffer.includes(0)) {
    throw new InvalidTextFileError(
      "Binary files cannot be opened in the text editor.",
    );
  }
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(buffer);
  } catch {
    throw new InvalidTextFileError(
      "The text editor accepts only valid UTF-8 files.",
    );
  }
}

export async function readWorkspaceTextFile(
  workspace: WorkspaceReference,
  relativePath: string,
): Promise<ReadTextResult> {
  const file = await readBoundedWorkspaceFile(
    workspace,
    relativePath,
    MAX_TEXT_FILE_BYTES,
  );
  const content = decodeUtf8Text(file.buffer);
  return {
    relativePath,
    content,
    contentHash: contentHash(file.buffer),
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
  };
}

export async function writeWorkspaceTextFile(
  workspace: WorkspaceReference,
  request: { relativePath: string; content: string; expectedContentHash?: string },
): Promise<ReadTextResult> {
  assertWorkspaceWritable(workspace);
  const contentBuffer = Buffer.from(request.content, "utf8");
  if (contentBuffer.byteLength > MAX_TEXT_FILE_BYTES) {
    throw new FileTooLargeError(contentBuffer.byteLength);
  }
  if (contentBuffer.includes(0)) {
    throw new InvalidTextFileError(
      "NUL bytes are not accepted by the text editor.",
    );
  }

  const target = await resolveWritableWorkspacePath(workspace, request.relativePath);
  let currentMode: number | undefined;
  let actualHash = "";
  try {
    const current = await readBoundedWorkspaceFile(
      workspace,
      request.relativePath,
      MAX_TEXT_FILE_BYTES,
    );
    if (current.absolutePath !== target) {
      throw new Error("The target path changed while the file was being saved.");
    }
    currentMode = current.mode & 0o777;
    actualHash = contentHash(current.buffer);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (
    request.expectedContentHash !== undefined &&
    request.expectedContentHash !== actualHash
  ) {
    throw new FileConflictError(request.expectedContentHash, actualHash);
  }

  const temporary = join(
    dirname(target),
    `.${basename(target)}.constelix-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, contentBuffer, { mode: currentMode ?? 0o600, flag: "wx" });
    if (currentMode !== undefined) await chmod(temporary, currentMode);
    const revalidatedTarget = await resolveWritableWorkspacePath(
      workspace,
      request.relativePath,
    );
    if (revalidatedTarget !== target) {
      throw new Error("The target path changed while the file was being saved.");
    }
    await rename(temporary, revalidatedTarget);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }

  return readWorkspaceTextFile(workspace, request.relativePath);
}
