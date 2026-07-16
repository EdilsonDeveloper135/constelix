import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  resolveExistingWorkspacePath,
  resolveWritableWorkspacePath,
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

  constructor(readonly sizeBytes: number) {
    super(`Text files are limited to ${MAX_TEXT_FILE_BYTES} bytes.`);
    this.name = "FileTooLargeError";
  }
}

export interface ReadTextResult {
  relativePath: string;
  content: string;
  contentHash: string;
  sizeBytes: number;
  mtimeMs: number;
}

export async function readWorkspaceTextFile(
  workspaceRoot: string,
  relativePath: string,
): Promise<ReadTextResult> {
  const path = await resolveExistingWorkspacePath(workspaceRoot, relativePath);
  const info = await stat(path);
  if (!info.isFile()) throw new Error("The requested path is not a file.");
  if (info.size > MAX_TEXT_FILE_BYTES) throw new FileTooLargeError(info.size);

  const contentBuffer = await readFile(path);
  if (contentBuffer.includes(0)) {
    throw new Error("Binary files cannot be opened in the text editor.");
  }
  const content = contentBuffer.toString("utf8");
  return {
    relativePath,
    content,
    contentHash: contentHash(contentBuffer),
    sizeBytes: contentBuffer.byteLength,
    mtimeMs: info.mtimeMs,
  };
}

export async function writeWorkspaceTextFile(
  workspaceRoot: string,
  request: { relativePath: string; content: string; expectedContentHash?: string },
): Promise<ReadTextResult> {
  const contentBuffer = Buffer.from(request.content, "utf8");
  if (contentBuffer.byteLength > MAX_TEXT_FILE_BYTES) {
    throw new FileTooLargeError(contentBuffer.byteLength);
  }
  if (contentBuffer.includes(0)) {
    throw new Error("NUL bytes are not accepted by the text editor.");
  }

  const target = await resolveWritableWorkspacePath(workspaceRoot, request.relativePath);
  let currentMode: number | undefined;
  let actualHash = "";
  try {
    const current = await readFile(target);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("The requested path is not a file.");
    currentMode = info.mode;
    actualHash = contentHash(current);
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
      workspaceRoot,
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

  return readWorkspaceTextFile(workspaceRoot, request.relativePath);
}
