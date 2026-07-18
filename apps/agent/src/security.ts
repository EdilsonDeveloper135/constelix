import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

const SENSITIVE_PATH_PATTERNS = [
  /(?:^|\/)\.env(?:\..+)?$/i,
  /(?:^|\/)(?:\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.s3cfg|\.boto|\.vault-token|\.terraformrc|auth\.json)$/i,
  /(?:^|\/)(?:credentials|secrets?)(?:\.[^/]*)?$/i,
  /(?:^|\/)\.aws\/(?:credentials|config)$/i,
  /(?:^|\/)\.azure\/(?:accessTokens\.json|azureProfile\.json)$/i,
  /(?:^|\/)\.config\/(?:gcloud\/(?:application_default_credentials\.json|credentials\.db|legacy_credentials\/[^/]+\/adc\.json)|gh\/hosts\.yml|glab-cli\/config\.yml|rclone\/rclone\.conf|pip\/pip\.conf|pypoetry\/auth\.toml)$/i,
  /(?:^|\/)\.(?:kube|docker)\/config(?:\.json)?$/i,
  /(?:^|\/)\.terraform\.d\/credentials\.tfrc\.json$/i,
  /(?:^|\/)(?:application_default_credentials|client_secret[^/]*|[^/]*service-account[^/]*)\.json$/i,
  /(?:^|\/)(?:terraform\.tfstate(?:\.backup)?|[^/]+\.auto\.tfvars|[^/]+\.tfvars)$/i,
  /\.(?:pem|key|p12|pfx|jks)$/i,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/i,
] as const;

const CLEAR_SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIza[A-Za-z0-9_-]{35}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bsk_live_[A-Za-z0-9]{20,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
] as const;

const SECRET_ASSIGNMENT_PATTERN =
  /(?:(?:aws[_-]?)?secret[_-]?access[_-]?key|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret|password|passwd)\s*[=:]\s*["']?([^\s"',;]{8,})/gi;

const PLACEHOLDER_MARKERS = [
  "${",
  "<",
  "changeme",
  "dummy",
  "example",
  "placeholder",
  "process.env",
  "redacted",
  "replace_me",
  "test-only",
  "your_",
] as const;

export class PathSecurityError extends Error {
  readonly code = "PATH_OUTSIDE_WORKSPACE";

  constructor(message: string) {
    super(message);
    this.name = "PathSecurityError";
  }
}

export class WorkspaceValidationError extends Error {
  constructor(
    readonly code:
      | "WORKSPACE_NOT_FOUND"
      | "WORKSPACE_NOT_DIRECTORY"
      | "WORKSPACE_PERMISSION_DENIED"
      | "WORKSPACE_VALIDATION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceValidationError";
  }
}

export class WorkspaceIdentityError extends Error {
  readonly code = "WORKSPACE_ROOT_CHANGED";

  constructor() {
    super("La raíz del workspace cambió durante la ejecución. Constelix detuvo el acceso.");
    this.name = "WorkspaceIdentityError";
  }
}

export class WorkspaceReadOnlyError extends Error {
  readonly code = "WORKSPACE_READ_ONLY";

  constructor() {
    super("El workspace está abierto en Modo Lectura.");
    this.name = "WorkspaceReadOnlyError";
  }
}

export interface WorkspaceIdentity {
  dev: number;
  ino: number;
}

export interface WorkspaceDescriptor {
  canonicalRoot: string;
  workspaceId: string;
  mode: "read" | "edit";
  readOnly: boolean;
  identity: WorkspaceIdentity;
}

export interface InspectWorkspaceOptions {
  forceReadOnly?: boolean | undefined;
}

export type WorkspaceReference = string | WorkspaceDescriptor;

export async function inspectWorkspace(
  inputPath: string,
  options: InspectWorkspaceOptions = {},
): Promise<WorkspaceDescriptor> {
  if (inputPath.includes("\0")) {
    throw new PathSecurityError("Workspace paths cannot contain NUL bytes.");
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(resolve(inputPath));
  } catch (error) {
    throw mapWorkspaceValidationError(error);
  }

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(canonicalRoot);
  } catch (error) {
    throw mapWorkspaceValidationError(error);
  }
  if (!info.isDirectory()) {
    throw new WorkspaceValidationError(
      "WORKSPACE_NOT_DIRECTORY",
      "La ruta del workspace debe ser un directorio.",
    );
  }

  try {
    await access(canonicalRoot, constants.R_OK);
  } catch {
    throw new WorkspaceValidationError(
      "WORKSPACE_PERMISSION_DENIED",
      "Constelix no tiene permisos de lectura sobre el workspace.",
    );
  }

  let writable = true;
  try {
    await access(canonicalRoot, constants.W_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS") {
      throw mapWorkspaceValidationError(error);
    }
    writable = false;
  }
  const readOnly = options.forceReadOnly === true || !writable;

  return {
    canonicalRoot,
    workspaceId: createWorkspaceId(canonicalRoot),
    mode: readOnly ? "read" : "edit",
    readOnly,
    identity: { dev: info.dev, ino: info.ino },
  };
}

export async function canonicalizeWorkspace(inputPath: string): Promise<string> {
  return (await inspectWorkspace(inputPath)).canonicalRoot;
}

export function createWorkspaceId(canonicalRoot: string): string {
  return createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 24);
}

export async function assertWorkspaceIdentity(
  workspace: WorkspaceDescriptor,
): Promise<void> {
  try {
    const canonicalRoot = await realpath(workspace.canonicalRoot);
    if (canonicalRoot !== workspace.canonicalRoot) throw new WorkspaceIdentityError();
    const info = await stat(canonicalRoot);
    if (
      !info.isDirectory() ||
      info.dev !== workspace.identity.dev ||
      info.ino !== workspace.identity.ino
    ) {
      throw new WorkspaceIdentityError();
    }
    await access(canonicalRoot, constants.R_OK);
  } catch (error) {
    if (error instanceof WorkspaceIdentityError) throw error;
    throw new WorkspaceIdentityError();
  }
}

export async function assertWorkspaceReferenceIdentity(
  workspace: WorkspaceReference,
): Promise<void> {
  if (typeof workspace !== "string") {
    await assertWorkspaceIdentity(workspace);
  }
}

export function assertWorkspaceWritable(workspace: WorkspaceReference): void {
  if (typeof workspace !== "string" && workspace.readOnly) {
    throw new WorkspaceReadOnlyError();
  }
}

export function workspaceRootOf(workspace: WorkspaceReference): string {
  return typeof workspace === "string" ? workspace : workspace.canonicalRoot;
}

export function summarizeWorkspacePath(
  canonicalRoot: string,
  userHome = homedir(),
): string {
  if (canonicalRoot === userHome) return "~";
  const name = basename(canonicalRoot) || "workspace";
  return isPathWithin(userHome, canonicalRoot) ? `~/…/${name}` : `…/${name}`;
}

export function redactLocalPaths(
  value: string,
  workspaceRoot?: string,
  userHome = homedir(),
): string {
  let redacted = value;
  for (const alias of localPathAliases(workspaceRoot)) {
    redacted = replaceAllLiteral(redacted, alias, "<workspace>");
  }
  for (const alias of localPathAliases(userHome)) {
    redacted = replaceAllLiteral(redacted, alias, "~");
  }
  return redacted;
}

export function normalizeRelativePath(inputPath: string): string {
  if (!inputPath || inputPath === ".") return ".";
  if (inputPath.includes("\0")) {
    throw new PathSecurityError("Paths cannot contain NUL bytes.");
  }
  if (isAbsolute(inputPath)) {
    throw new PathSecurityError("Absolute paths are not accepted by workspace APIs.");
  }

  const normalized = inputPath.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (parts.some((part) => part === "..")) {
    throw new PathSecurityError("Path traversal outside the workspace is not allowed.");
  }

  return parts.filter((part) => part && part !== ".").join("/") || ".";
}

function assertContained(workspaceRoot: string, candidate: string): void {
  const pathFromRoot = relative(workspaceRoot, candidate);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new PathSecurityError("The resolved path is outside the workspace.");
  }
}

/**
 * Resolves an existing path and rejects symlinks whose final target escapes the
 * workspace. API consumers must only expose the returned canonical path.
 */
export async function resolveExistingWorkspacePath(
  workspace: WorkspaceReference,
  relativePath: string,
): Promise<string> {
  const canonicalRoot = await canonicalWorkspaceRoot(workspace);
  const normalized = normalizeRelativePath(relativePath);
  const candidate = resolve(canonicalRoot, normalized);
  assertContained(canonicalRoot, candidate);
  const canonical = await realpath(candidate);
  assertContained(canonicalRoot, canonical);
  return canonical;
}

/**
 * Resolves a file that may not exist yet. Its canonical parent must exist and
 * stay inside the workspace, preventing writes through escaping symlinks.
 */
export async function resolveWritableWorkspacePath(
  workspace: WorkspaceReference,
  relativePath: string,
): Promise<string> {
  assertWorkspaceWritable(workspace);
  const canonicalRoot = await canonicalWorkspaceRoot(workspace);
  const normalized = normalizeRelativePath(relativePath);
  if (normalized === ".") {
    throw new PathSecurityError("The workspace root cannot be written as a file.");
  }

  const candidate = resolve(canonicalRoot, normalized);
  assertContained(canonicalRoot, candidate);

  const parent = resolve(candidate, "..");
  const canonicalParent = await realpath(parent);
  assertContained(canonicalRoot, canonicalParent);

  const finalCandidate = resolve(canonicalParent, candidate.slice(parent.length + 1));
  assertContained(canonicalRoot, finalCandidate);

  try {
    const canonical = await realpath(finalCandidate);
    assertContained(canonicalRoot, canonical);
    return canonical;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    return finalCandidate;
  }
}

export function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string {
  assertContained(workspaceRoot, absolutePath);
  const result = relative(workspaceRoot, absolutePath).split(sep).join("/");
  return result || ".";
}

/** Files that must never be offered to an external AI provider as context. */
export function isSensitiveCredentialPath(inputPath: string): boolean {
  const normalized = inputPath.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized.length === 0 || SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Detects high-confidence credential material. It intentionally ignores common
 * placeholders so documentation and environment-variable based code remain usable.
 */
export function containsClearlySecretContent(value: string): boolean {
  if (CLEAR_SECRET_PATTERNS.some((pattern) => pattern.test(value))) return true;
  SECRET_ASSIGNMENT_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(SECRET_ASSIGNMENT_PATTERN)) {
    const candidate = match[1]?.toLocaleLowerCase();
    if (candidate === undefined) continue;
    if (PLACEHOLDER_MARKERS.some((marker) => candidate.includes(marker))) continue;
    if (/^(?:x+|\*+|0+|-)$/i.test(candidate)) continue;
    return true;
  }
  return false;
}

export function redactSecrets(value: string): string {
  let redacted = value;
  for (const pattern of CLEAR_SECRET_PATTERNS) {
    redacted = redacted.replace(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`), "[REDACTED_CREDENTIAL]");
  }
  return redacted
    .replace(
      /((?:(?:aws[_-]?)?secret[_-]?access[_-]?key|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|token|secret|password|passwd)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    );
}

export function createSafeChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const permitted = new Set([
    "HOME",
    "PATH",
    "SHELL",
    "TERM",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "USER",
    "LOGNAME",
    "COLORTERM",
    "FORCE_COLOR",
  ]);
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (permitted.has(key) && value !== undefined) result[key] = value;
  }
  return result;
}

async function canonicalWorkspaceRoot(workspace: WorkspaceReference): Promise<string> {
  if (typeof workspace === "string") return realpath(workspace);
  await assertWorkspaceIdentity(workspace);
  return workspace.canonicalRoot;
}

function mapWorkspaceValidationError(error: unknown): WorkspaceValidationError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return new WorkspaceValidationError(
      "WORKSPACE_NOT_FOUND",
      "La ruta del workspace no existe.",
    );
  }
  if (code === "ENOTDIR") {
    return new WorkspaceValidationError(
      "WORKSPACE_NOT_DIRECTORY",
      "La ruta del workspace debe ser un directorio.",
    );
  }
  if (code === "EACCES" || code === "EPERM") {
    return new WorkspaceValidationError(
      "WORKSPACE_PERMISSION_DENIED",
      "Constelix no tiene permisos para abrir el workspace.",
    );
  }
  return new WorkspaceValidationError(
    "WORKSPACE_VALIDATION_FAILED",
    "Constelix no pudo validar el workspace.",
  );
}

function isPathWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`))
  );
}

function replaceAllLiteral(value: string, search: string, replacement: string): string {
  return search ? value.split(search).join(replacement) : value;
}

function localPathAliases(path: string | undefined): string[] {
  if (!path) return [];
  const aliases = new Set([path]);
  if (path === "/private/var" || path.startsWith("/private/var/")) {
    aliases.add(path.slice("/private".length));
  } else if (path === "/var" || path.startsWith("/var/")) {
    aliases.add(`/private${path}`);
  }
  if (path === "/private/tmp" || path.startsWith("/private/tmp/")) {
    aliases.add(path.slice("/private".length));
  } else if (path === "/tmp" || path.startsWith("/tmp/")) {
    aliases.add(`/private${path}`);
  }
  return [...aliases].sort((left, right) => right.length - left.length);
}
