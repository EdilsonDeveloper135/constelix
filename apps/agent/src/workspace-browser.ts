import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { constants, type Dirent } from "node:fs";
import {
  access,
  lstat,
  opendir,
  realpath,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
} from "node:path";

export const MAX_WORKSPACE_BROWSE_ENTRIES = 200;
export const DEFAULT_WORKSPACE_BROWSE_ENTRIES = 100;
export const MAX_WORKSPACE_BROWSE_DIRECTORY_ENTRIES = 100_000;
const MIN_WORKSPACE_BROWSE_INSPECTIONS = 400;

export type WorkspaceBrowserErrorCode =
  | "WORKSPACE_PATH_INVALID"
  | "WORKSPACE_PATH_NOT_FOUND"
  | "WORKSPACE_PATH_NOT_DIRECTORY"
  | "WORKSPACE_PATH_UNREADABLE"
  | "WORKSPACE_BROWSE_CURSOR_INVALID"
  | "WORKSPACE_BROWSE_LIMIT_INVALID"
  | "WORKSPACE_BROWSE_TOO_LARGE"
  | "WORKSPACE_BROWSE_FAILED";

export class WorkspaceBrowserError extends Error {
  constructor(
    readonly code: WorkspaceBrowserErrorCode,
    message: string,
    readonly recoverable = true,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceBrowserError";
  }
}

export interface WorkspaceBrowserOptions {
  cursorSecret?: string | Uint8Array;
  maxDirectoryEntries?: number;
}

export interface WorkspaceBrowseInput {
  path: string;
  showHidden?: boolean;
  cursor?: string;
  limit?: number;
}

export interface WorkspaceDirectoryEntry {
  name: string;
  path: string;
  canonicalPath: string;
  symbolicLink: boolean;
  readable: boolean;
}

export interface WorkspaceBrowsePage {
  path: string;
  parentPath?: string;
  entries: WorkspaceDirectoryEntry[];
  nextCursor?: string;
  truncated: boolean;
}

interface CursorPayload {
  version: 1;
  directoryHash: string;
  listingHash: string;
  showHidden: boolean;
  offset: number;
}

export class WorkspaceBrowser {
  private readonly cursorSecret: Buffer;
  private readonly maxDirectoryEntries: number;

  constructor(options: WorkspaceBrowserOptions = {}) {
    this.cursorSecret = options.cursorSecret === undefined
      ? randomBytes(32)
      : Buffer.from(options.cursorSecret);
    if (this.cursorSecret.byteLength < 16) {
      throw new TypeError("cursorSecret must contain at least 16 bytes.");
    }
    this.maxDirectoryEntries = Math.trunc(
      options.maxDirectoryEntries ?? MAX_WORKSPACE_BROWSE_DIRECTORY_ENTRIES,
    );
    if (
      this.maxDirectoryEntries < 1 ||
      this.maxDirectoryEntries > MAX_WORKSPACE_BROWSE_DIRECTORY_ENTRIES
    ) {
      throw new TypeError(
        `maxDirectoryEntries must be between 1 and ${MAX_WORKSPACE_BROWSE_DIRECTORY_ENTRIES}.`,
      );
    }
  }

  async browse(input: WorkspaceBrowseInput): Promise<WorkspaceBrowsePage> {
    const requestedPath = validateBrowsePath(input.path);
    const showHidden = input.showHidden ?? false;
    const limit = validateLimit(
      input.limit ?? DEFAULT_WORKSPACE_BROWSE_ENTRIES,
    );
    const canonicalPath = await resolveDirectory(requestedPath);
    const directoryHash = hashDirectory(canonicalPath);

    const candidates: Dirent[] = [];
    try {
      await access(canonicalPath, constants.R_OK | constants.X_OK);
      const directory = await opendir(canonicalPath);
      let entriesVisited = 0;
      for await (const entry of directory) {
        entriesVisited += 1;
        if (entriesVisited > this.maxDirectoryEntries) {
          throw new WorkspaceBrowserError(
            "WORKSPACE_BROWSE_TOO_LARGE",
            `La carpeta supera el límite seguro de ${this.maxDirectoryEntries} entradas.`,
          );
        }
        if (
          (showHidden || !entry.name.startsWith(".")) &&
          (entry.isDirectory() || entry.isSymbolicLink())
        ) {
          candidates.push(entry);
        }
      }
    } catch (error) {
      if (error instanceof WorkspaceBrowserError) throw error;
      throw mapFileSystemError(error, "WORKSPACE_BROWSE_FAILED");
    }

    candidates.sort((left, right) => compareEntryNames(left.name, right.name));
    const listingHash = hashDirectoryListing(candidates);
    const offset = input.cursor === undefined
      ? 0
      : this.decodeCursor(
          input.cursor,
          directoryHash,
          listingHash,
          showHidden,
        );
    const entries: WorkspaceDirectoryEntry[] = [];
    if (offset > candidates.length) {
      throw new WorkspaceBrowserError(
        "WORKSPACE_BROWSE_CURSOR_INVALID",
        "El cursor de exploración ya no corresponde al contenido del directorio.",
      );
    }
    const inspectionBudget = Math.max(
      MIN_WORKSPACE_BROWSE_INSPECTIONS,
      limit * 4,
    );
    let nextOffset = offset;
    let inspected = 0;
    while (
      nextOffset < candidates.length &&
      entries.length < limit &&
      inspected < inspectionBudget
    ) {
      const candidate = candidates[nextOffset];
      nextOffset += 1;
      inspected += 1;
      if (!candidate) continue;
      const entry = await inspectDirectoryEntry(canonicalPath, candidate.name);
      if (entry !== undefined) entries.push(entry);
    }

    const truncated = nextOffset < candidates.length;
    const parent = parentDirectory(canonicalPath);
    return {
      path: canonicalPath,
      ...(parent === undefined ? {} : { parentPath: parent }),
      entries,
      ...(truncated
        ? {
            nextCursor: this.encodeCursor({
              version: 1,
              directoryHash,
              listingHash,
              showHidden,
              offset: nextOffset,
            }),
          }
        : {}),
      truncated,
    };
  }

  private encodeCursor(payload: CursorPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
      "base64url",
    );
    const signature = createHmac("sha256", this.cursorSecret)
      .update(encoded)
      .digest("base64url");
    return `${encoded}.${signature}`;
  }

  private decodeCursor(
    cursor: string,
    directoryHash: string,
    listingHash: string,
    showHidden: boolean,
  ): number {
    try {
      const parts = cursor.split(".");
      if (parts.length !== 2) throw new Error("Malformed cursor.");
      const encoded = parts[0];
      const suppliedSignature = parts[1];
      if (!encoded || !suppliedSignature) throw new Error("Malformed cursor.");
      const expectedSignature = createHmac("sha256", this.cursorSecret)
        .update(encoded)
        .digest();
      const supplied = Buffer.from(suppliedSignature, "base64url");
      if (
        supplied.toString("base64url") !== suppliedSignature ||
        supplied.byteLength !== expectedSignature.byteLength ||
        !timingSafeEqual(supplied, expectedSignature)
      ) {
        throw new Error("Invalid cursor signature.");
      }
      const parsed = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      ) as Partial<CursorPayload>;
      if (
        parsed.version !== 1 ||
        parsed.directoryHash !== directoryHash ||
        parsed.listingHash !== listingHash ||
        parsed.showHidden !== showHidden ||
        !Number.isSafeInteger(parsed.offset) ||
        (parsed.offset ?? -1) < 0
      ) {
        throw new Error("Cursor context mismatch.");
      }
      return parsed.offset as number;
    } catch (error) {
      throw new WorkspaceBrowserError(
        "WORKSPACE_BROWSE_CURSOR_INVALID",
        "El cursor de exploración no es válido para este directorio.",
        true,
        { cause: error },
      );
    }
  }
}

async function resolveDirectory(requestedPath: string): Promise<string> {
  try {
    await lstat(requestedPath);
    const canonicalPath = normalize(await realpath(requestedPath));
    const information = await lstat(canonicalPath);
    if (!information.isDirectory()) {
      throw new WorkspaceBrowserError(
        "WORKSPACE_PATH_NOT_DIRECTORY",
        "Selecciona una carpeta, no un archivo.",
      );
    }
    return canonicalPath;
  } catch (error) {
    if (error instanceof WorkspaceBrowserError) throw error;
    throw mapFileSystemError(error, "WORKSPACE_BROWSE_FAILED");
  }
}

async function inspectDirectoryEntry(
  parent: string,
  name: string,
): Promise<WorkspaceDirectoryEntry | undefined> {
  const path = join(parent, name);
  try {
    const information = await lstat(path);
    const symbolicLink = information.isSymbolicLink();
    if (!symbolicLink && !information.isDirectory()) return undefined;
    const canonicalPath = normalize(await realpath(path));
    const targetInformation = symbolicLink
      ? await lstat(canonicalPath)
      : information;
    if (!targetInformation.isDirectory()) return undefined;
    const readable = await access(
      canonicalPath,
      constants.R_OK | constants.X_OK,
    ).then(
      () => true,
      () => false,
    );
    return { name, path, canonicalPath, symbolicLink, readable };
  } catch {
    // Broken, raced, or inaccessible symlinks are not usable directories.
    return undefined;
  }
}

function validateBrowsePath(value: string): string {
  if (
    !value ||
    value.includes("\0") ||
    value.length > 4096 ||
    !isAbsolute(value)
  ) {
    throw new WorkspaceBrowserError(
      "WORKSPACE_PATH_INVALID",
      "La ruta debe ser absoluta y no puede contener bytes nulos.",
    );
  }
  return normalize(value);
}

function validateLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_WORKSPACE_BROWSE_ENTRIES
  ) {
    throw new WorkspaceBrowserError(
      "WORKSPACE_BROWSE_LIMIT_INVALID",
      `El límite debe estar entre 1 y ${MAX_WORKSPACE_BROWSE_ENTRIES}.`,
    );
  }
  return value;
}

function parentDirectory(path: string): string | undefined {
  const root = parse(path).root;
  return path === root ? undefined : dirname(path);
}

function hashDirectory(path: string): string {
  return createHash("sha256").update(path).digest("base64url");
}

function hashDirectoryListing(
  entries: Array<{
    name: string;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }>,
): string {
  const listing = entries.map((entry) => [
    entry.name,
    entry.isDirectory() ? "directory" : "symlink",
  ]);
  return createHash("sha256")
    .update(JSON.stringify(listing))
    .digest("base64url");
}

function compareEntryNames(left: string, right: string): number {
  const insensitive = left.localeCompare(right, "en", {
    numeric: true,
    sensitivity: "base",
  });
  return insensitive === 0 ? left.localeCompare(right, "en") : insensitive;
}

function mapFileSystemError(
  error: unknown,
  fallback: WorkspaceBrowserErrorCode,
): WorkspaceBrowserError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return new WorkspaceBrowserError(
      "WORKSPACE_PATH_NOT_FOUND",
      "No encontramos esa carpeta.",
      true,
      { cause: error },
    );
  }
  if (code === "ENOTDIR") {
    return new WorkspaceBrowserError(
      "WORKSPACE_PATH_NOT_DIRECTORY",
      "Selecciona una carpeta, no un archivo.",
      true,
      { cause: error },
    );
  }
  if (code === "EACCES" || code === "EPERM") {
    return new WorkspaceBrowserError(
      "WORKSPACE_PATH_UNREADABLE",
      "Constelix no puede leer esta carpeta.",
      true,
      { cause: error },
    );
  }
  return new WorkspaceBrowserError(
    fallback,
    "No se pudo explorar la carpeta.",
    true,
    { cause: error },
  );
}
