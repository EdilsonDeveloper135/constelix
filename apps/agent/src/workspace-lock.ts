import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

export const WORKSPACE_LOCK_VERSION = 1 as const;
export const DEFAULT_WORKSPACE_LOCK_HEARTBEAT_MS = 5_000;
export const DEFAULT_WORKSPACE_LOCK_STALE_AFTER_MS = 15_000;
export const DEFAULT_WORKSPACE_LOCK_INITIALIZING_GRACE_MS = 2_000;

const DEFAULT_GUARD_RETRY_MS = 25;
const DEFAULT_GUARD_TIMEOUT_MS = 5_000;
const DEFAULT_GUARD_STALE_AFTER_MS = 15_000;
const MAX_LOCK_BYTES = 16 * 1024;
const MAX_FUTURE_HEARTBEAT_SKEW_MS = 5_000;
const PROCESS_BOOT_TIMESTAMP = new Date().toISOString();

export interface WorkspaceLockMetadataV1 {
  version: typeof WORKSPACE_LOCK_VERSION;
  lockId: string;
  pid: number;
  bootTimestamp: string;
  execPath: string;
  agentVersion: string;
  workspaceId: string;
  workspacePath: string;
  createdAt: string;
}

export interface LegacyWorkspaceLockMetadata {
  version: 0;
  pid: number;
  nonce?: string;
  workspaceId?: string;
  createdAt?: string;
}

export type ProcessLiveness = "alive" | "dead" | "unknown";

export interface ProcessInspector {
  liveness(pid: number): Promise<ProcessLiveness>;
  executablePath(pid: number): Promise<string | undefined>;
}

export type WorkspaceLockClassification =
  | "missing"
  | "active"
  | "stale-safe"
  | "ambiguous"
  | "initializing";

export type WorkspaceLockReason =
  | "lock-missing"
  | "owner-active"
  | "owner-dead"
  | "owner-unknown"
  | "executable-mismatch"
  | "executable-unknown"
  | "heartbeat-stale"
  | "heartbeat-in-future"
  | "legacy-owner-live"
  | "legacy-owner-unknown"
  | "metadata-incomplete"
  | "metadata-invalid"
  | "metadata-version-unknown"
  | "workspace-mismatch"
  | "lock-not-regular"
  | "lock-changed";

export interface WorkspaceLockFileIdentity {
  dev: number;
  ino: number;
}

export interface WorkspaceLockInspection {
  classification: WorkspaceLockClassification;
  reason: WorkspaceLockReason;
  lockId?: string;
  metadata?: WorkspaceLockMetadataV1 | LegacyWorkspaceLockMetadata;
  heartbeatAt?: string;
  heartbeatAgeMs?: number;
  identity?: WorkspaceLockFileIdentity;
}

export interface WorkspaceLockDependencies {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  processInspector: ProcessInspector;
  setInterval(
    callback: () => void,
    milliseconds: number,
  ): NodeJS.Timeout;
  clearInterval(timer: NodeJS.Timeout): void;
}

export interface WorkspaceLockOptions {
  lockPath: string;
  workspaceId: string;
  workspacePath: string;
  agentVersion: string;
  pid?: number;
  execPath?: string;
  bootTimestamp?: string;
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  initializingGraceMs?: number;
  guardRetryMs?: number;
  guardTimeoutMs?: number;
  guardStaleAfterMs?: number;
  force?: {
    expectedLockId: string;
  };
  onLost?: (error: WorkspaceLeaseLostError) => void | Promise<void>;
  dependencies?: Partial<WorkspaceLockDependencies>;
}

export interface WorkspaceLockInspectOptions {
  lockPath: string;
  workspaceId: string;
  workspacePath: string;
  staleAfterMs?: number;
  initializingGraceMs?: number;
  dependencies?: Partial<WorkspaceLockDependencies>;
}

interface ResolvedWorkspaceLockOptions {
  lockPath: string;
  workspaceId: string;
  workspacePath: string;
  agentVersion: string;
  pid: number;
  execPath: string;
  bootTimestamp: string;
  heartbeatIntervalMs: number;
  staleAfterMs: number;
  initializingGraceMs: number;
  guardRetryMs: number;
  guardTimeoutMs: number;
  guardStaleAfterMs: number;
  force?: {
    expectedLockId: string;
  };
  onLost?: (error: WorkspaceLeaseLostError) => void | Promise<void>;
  dependencies: WorkspaceLockDependencies;
}

interface ObservedLock {
  stats: Stats;
  identity: WorkspaceLockFileIdentity;
  lockId: string;
  metadata?: WorkspaceLockMetadataV1 | LegacyWorkspaceLockMetadata;
  unknownVersion?: boolean;
}

interface ParsedLockOwner {
  metadata?: WorkspaceLockMetadataV1 | LegacyWorkspaceLockMetadata;
  lockId: string;
  unknownVersion?: boolean;
}

interface GuardHandle {
  handle: FileHandle;
  guardId: string;
  identity: WorkspaceLockFileIdentity;
}

export class WorkspaceLockConflictError extends Error {
  readonly code = "WORKSPACE_LOCK_CONFLICT";

  constructor(readonly inspection: WorkspaceLockInspection) {
    super(
      inspection.classification === "active"
        ? "El workspace ya está abierto por otra instancia de Constelix."
        : "El lock del workspace requiere resolución antes de continuar.",
    );
    this.name = "WorkspaceLockConflictError";
  }
}

export class WorkspaceLockExpectedOwnerError extends Error {
  readonly code = "WORKSPACE_LOCK_OWNER_CHANGED";

  constructor(
    readonly expectedLockId: string,
    readonly actualLockId: string | undefined,
  ) {
    super("El lock cambió desde que fue inspeccionado; no se forzó su liberación.");
    this.name = "WorkspaceLockExpectedOwnerError";
  }
}

export class WorkspaceLockGuardTimeoutError extends Error {
  readonly code = "WORKSPACE_LOCK_GUARD_TIMEOUT";

  constructor() {
    super("No se pudo serializar la operación sobre el lock del workspace.");
    this.name = "WorkspaceLockGuardTimeoutError";
  }
}

export class WorkspaceLeaseLostError extends Error {
  readonly code = "WORKSPACE_LEASE_LOST";

  constructor(readonly lockId: string) {
    super("La instancia perdió la lease del workspace.");
    this.name = "WorkspaceLeaseLostError";
  }
}

export const defaultProcessInspector: ProcessInspector = {
  async liveness(pid) {
    try {
      process.kill(pid, 0);
      return "alive";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return "dead";
      return "unknown";
    }
  },
  async executablePath(pid) {
    if (process.platform === "win32") return undefined;
    return new Promise((resolveExecutable) => {
      execFile(
        "ps",
        ["-p", String(pid), "-o", "comm="],
        {
          encoding: "utf8",
          timeout: 1_000,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) {
            resolveExecutable(undefined);
            return;
          }
          const value = stdout.trim();
          resolveExecutable(value || undefined);
        },
      );
    });
  },
};

const DEFAULT_DEPENDENCIES: WorkspaceLockDependencies = {
  now: () => Date.now(),
  sleep: (milliseconds) =>
    new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  processInspector: defaultProcessInspector,
  setInterval: (callback, milliseconds) =>
    globalThis.setInterval(callback, milliseconds),
  clearInterval: (timer) => globalThis.clearInterval(timer),
};

export class WorkspaceLease {
  readonly metadata: WorkspaceLockMetadataV1;

  #timer: NodeJS.Timeout | undefined;
  #heartbeat: Promise<void> = Promise.resolve();
  #releasePromise: Promise<void> | undefined;
  #lostError: WorkspaceLeaseLostError | undefined;
  #released = false;

  private constructor(
    private readonly options: ResolvedWorkspaceLockOptions,
    private readonly handle: FileHandle,
    private readonly identity: WorkspaceLockFileIdentity,
    metadata: WorkspaceLockMetadataV1,
  ) {
    this.metadata = metadata;
  }

  static async acquire(options: WorkspaceLockOptions): Promise<WorkspaceLease> {
    const resolved = await resolveOptions(options);
    await prepareLockDirectory(resolved.lockPath);
    const guard = await acquireGuard(resolved);
    let lease: WorkspaceLease | undefined;
    let firstError: unknown;
    try {
      const inspection = await inspectWorkspaceLockWithResolvedOptions(resolved);
      await resolveExistingLock(resolved, inspection);
      lease = await WorkspaceLease.createLease(resolved);
    } catch (error) {
      firstError = error;
    }
    try {
      await releaseGuard(resolved, guard);
    } catch (error) {
      firstError ??= error;
      if (lease) {
        await lease.rollbackFailedAcquisition().catch(() => undefined);
        lease = undefined;
      }
      // Retry the identity-checked guard cleanup once after closing the lease.
      await releaseGuard(resolved, guard).catch(() => undefined);
    }
    if (firstError !== undefined) throw firstError;
    if (!lease) {
      throw new Error("Workspace lease acquisition did not produce a lease.");
    }
    lease.startHeartbeat();
    return lease;
  }

  private static async createLease(
    options: ResolvedWorkspaceLockOptions,
  ): Promise<WorkspaceLease> {
    const lockId = randomUUID();
    const now = options.dependencies.now();
    const metadata: WorkspaceLockMetadataV1 = {
      version: WORKSPACE_LOCK_VERSION,
      lockId,
      pid: options.pid,
      bootTimestamp: options.bootTimestamp,
      execPath: options.execPath,
      agentVersion: options.agentVersion,
      workspaceId: options.workspaceId,
      workspacePath: options.workspacePath,
      createdAt: new Date(now).toISOString(),
    };
    const handle = await open(options.lockPath, "wx", 0o600);
    const openedStats = await handle.stat();
    const identity = fileIdentity(openedStats);
    try {
      await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
      await handle.sync();
      const heartbeatTime = new Date(now);
      await handle.utimes(heartbeatTime, heartbeatTime);
      await chmod(options.lockPath, 0o600);
      return new WorkspaceLease(options, handle, identity, metadata);
    } catch (error) {
      await handle.close().catch(() => undefined);
      if (await pathIdentityMatches(options.lockPath, identity)) {
        await unlink(options.lockPath).catch(() => undefined);
      }
      throw error;
    }
  }

  get lost(): boolean {
    return this.#lostError !== undefined;
  }

  get released(): boolean {
    return this.#released;
  }

  async assertOwned(): Promise<void> {
    if (this.#released || this.#lostError) {
      throw this.#lostError ?? new WorkspaceLeaseLostError(this.metadata.lockId);
    }
    try {
      await assertLeaseFileOwnership(
        this.options.lockPath,
        this.identity,
        this.metadata.lockId,
      );
    } catch {
      throw this.markLost();
    }
  }

  async refreshHeartbeat(): Promise<void> {
    await this.assertOwned();
    const heartbeatTime = new Date(this.options.dependencies.now());
    try {
      await this.handle.utimes(heartbeatTime, heartbeatTime);
      await assertLeaseFileOwnership(
        this.options.lockPath,
        this.identity,
        this.metadata.lockId,
      );
    } catch {
      throw this.markLost();
    }
  }

  release(): Promise<void> {
    this.#releasePromise ??= this.releaseOnce();
    return this.#releasePromise;
  }

  private startHeartbeat(): void {
    if (this.#released || this.#lostError || this.#timer) return;
    this.#timer = this.options.dependencies.setInterval(() => {
      this.#heartbeat = this.#heartbeat
        .then(() => this.refreshHeartbeat())
        .catch(() => undefined);
    }, this.options.heartbeatIntervalMs);
    this.#timer.unref?.();
  }

  private async rollbackFailedAcquisition(): Promise<void> {
    this.#released = true;
    this.stopHeartbeat();
    let firstError: unknown;
    try {
      if (
        await lockFileMatches(
          this.options.lockPath,
          this.identity,
          this.metadata.lockId,
        )
      ) {
        await unlink(this.options.lockPath);
      }
    } catch (error) {
      firstError = error;
    }
    try {
      await this.handle.close();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError !== undefined) throw firstError;
  }

  private stopHeartbeat(): void {
    if (!this.#timer) return;
    this.options.dependencies.clearInterval(this.#timer);
    this.#timer = undefined;
  }

  private markLost(): WorkspaceLeaseLostError {
    if (this.#lostError) return this.#lostError;
    const error = new WorkspaceLeaseLostError(this.metadata.lockId);
    this.#lostError = error;
    this.stopHeartbeat();
    if (this.options.onLost) {
      void Promise.resolve(this.options.onLost(error)).catch(() => undefined);
    }
    return error;
  }

  private async releaseOnce(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    this.stopHeartbeat();
    await this.#heartbeat;

    let guard: GuardHandle | undefined;
    let firstError: unknown;
    try {
      guard = await acquireGuard(this.options);
      const owned = await lockFileMatches(
        this.options.lockPath,
        this.identity,
        this.metadata.lockId,
      );
      if (owned) {
        await unlink(this.options.lockPath);
      } else if (!this.#lostError) {
        this.markLost();
      }
    } catch (error) {
      firstError = error;
    } finally {
      if (guard) {
        try {
          await releaseGuard(this.options, guard);
        } catch (error) {
          firstError ??= error;
        }
      }
      try {
        await this.handle.close();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }
}

export async function inspectWorkspaceLock(
  options: WorkspaceLockInspectOptions,
): Promise<WorkspaceLockInspection> {
  const dependencies = resolveDependencies(options.dependencies);
  return inspectWorkspaceLockWithResolvedOptions({
    lockPath: options.lockPath,
    workspaceId: options.workspaceId,
    workspacePath: await canonicalizeRequiredPath(options.workspacePath),
    staleAfterMs: positiveDuration(
      options.staleAfterMs,
      DEFAULT_WORKSPACE_LOCK_STALE_AFTER_MS,
    ),
    initializingGraceMs: positiveDuration(
      options.initializingGraceMs,
      DEFAULT_WORKSPACE_LOCK_INITIALIZING_GRACE_MS,
    ),
    dependencies,
  });
}

async function resolveOptions(
  options: WorkspaceLockOptions,
): Promise<ResolvedWorkspaceLockOptions> {
  if (!options.workspaceId.trim()) {
    throw new Error("workspaceId is required to acquire a workspace lock.");
  }
  if (!options.agentVersion.trim()) {
    throw new Error("agentVersion is required to acquire a workspace lock.");
  }
  const dependencies = resolveDependencies(options.dependencies);
  const execPath = await canonicalizeExecutable(
    options.execPath ?? process.execPath,
  );
  return {
    lockPath: resolve(options.lockPath),
    workspaceId: options.workspaceId,
    workspacePath: await canonicalizeRequiredPath(options.workspacePath),
    agentVersion: options.agentVersion,
    pid: options.pid ?? process.pid,
    execPath,
    bootTimestamp: options.bootTimestamp ?? PROCESS_BOOT_TIMESTAMP,
    heartbeatIntervalMs: positiveDuration(
      options.heartbeatIntervalMs,
      DEFAULT_WORKSPACE_LOCK_HEARTBEAT_MS,
    ),
    staleAfterMs: positiveDuration(
      options.staleAfterMs,
      DEFAULT_WORKSPACE_LOCK_STALE_AFTER_MS,
    ),
    initializingGraceMs: positiveDuration(
      options.initializingGraceMs,
      DEFAULT_WORKSPACE_LOCK_INITIALIZING_GRACE_MS,
    ),
    guardRetryMs: positiveDuration(
      options.guardRetryMs,
      DEFAULT_GUARD_RETRY_MS,
    ),
    guardTimeoutMs: positiveDuration(
      options.guardTimeoutMs,
      DEFAULT_GUARD_TIMEOUT_MS,
    ),
    guardStaleAfterMs: positiveDuration(
      options.guardStaleAfterMs,
      DEFAULT_GUARD_STALE_AFTER_MS,
    ),
    ...(options.force === undefined ? {} : { force: options.force }),
    ...(options.onLost === undefined ? {} : { onLost: options.onLost }),
    dependencies,
  };
}

function resolveDependencies(
  dependencies: Partial<WorkspaceLockDependencies> | undefined,
): WorkspaceLockDependencies {
  return {
    now: dependencies?.now ?? DEFAULT_DEPENDENCIES.now,
    sleep: dependencies?.sleep ?? DEFAULT_DEPENDENCIES.sleep,
    processInspector:
      dependencies?.processInspector ?? DEFAULT_DEPENDENCIES.processInspector,
    setInterval:
      dependencies?.setInterval ?? DEFAULT_DEPENDENCIES.setInterval,
    clearInterval:
      dependencies?.clearInterval ?? DEFAULT_DEPENDENCIES.clearInterval,
  };
}

function positiveDuration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Workspace lock durations must be positive finite numbers.");
  }
  return value;
}

async function canonicalizeRequiredPath(path: string): Promise<string> {
  return realpath(resolve(path));
}

async function canonicalizeExecutable(path: string): Promise<string> {
  const absolute = isAbsolute(path) ? path : resolve(path);
  return realpath(absolute).catch(() => absolute);
}

async function prepareLockDirectory(lockPath: string): Promise<void> {
  const directory = dirname(lockPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function resolveExistingLock(
  options: ResolvedWorkspaceLockOptions,
  inspection: WorkspaceLockInspection,
): Promise<void> {
  if (inspection.classification === "missing") return;

  if (options.force) {
    if (inspection.lockId !== options.force.expectedLockId) {
      throw new WorkspaceLockExpectedOwnerError(
        options.force.expectedLockId,
        inspection.lockId,
      );
    }
    if (inspection.classification === "active") {
      throw new WorkspaceLockConflictError(inspection);
    }
    if (
      inspection.classification !== "stale-safe" &&
      inspection.classification !== "ambiguous"
    ) {
      throw new WorkspaceLockConflictError(inspection);
    }
  } else if (inspection.classification !== "stale-safe") {
    throw new WorkspaceLockConflictError(inspection);
  }

  const observation = await observeLock(options.lockPath);
  if (!observation) return;
  if (
    observation.lockId !== inspection.lockId ||
    !sameIdentity(observation.identity, inspection.identity)
  ) {
    throw new WorkspaceLockExpectedOwnerError(
      inspection.lockId ?? "",
      observation.lockId,
    );
  }
  const removed = await removeObservedLock(options.lockPath, observation);
  if (!removed) {
    throw new WorkspaceLockExpectedOwnerError(
      observation.lockId,
      (await observeLock(options.lockPath))?.lockId,
    );
  }
}

async function inspectWorkspaceLockWithResolvedOptions(options: {
  lockPath: string;
  workspaceId: string;
  workspacePath: string;
  staleAfterMs: number;
  initializingGraceMs: number;
  dependencies: WorkspaceLockDependencies;
}): Promise<WorkspaceLockInspection> {
  let observation: ObservedLock | undefined;
  try {
    observation = await observeLock(options.lockPath);
  } catch {
    return {
      classification: "initializing",
      reason: "lock-changed",
    };
  }
  if (!observation) {
    return {
      classification: "missing",
      reason: "lock-missing",
    };
  }

  const now = options.dependencies.now();
  const heartbeatAgeMs = now - observation.stats.mtimeMs;
  const common = {
    lockId: observation.lockId,
    heartbeatAt: new Date(observation.stats.mtimeMs).toISOString(),
    heartbeatAgeMs,
    identity: observation.identity,
  };

  if (!observation.stats.isFile()) {
    return {
      classification:
        heartbeatAgeMs <= options.initializingGraceMs
          ? "initializing"
          : "ambiguous",
      reason: "lock-not-regular",
      ...common,
    };
  }

  const owner = observation.metadata;
  if (observation.unknownVersion) {
    return {
      classification:
        heartbeatAgeMs <= options.initializingGraceMs
          ? "initializing"
          : "ambiguous",
      reason: "metadata-version-unknown",
      ...common,
    };
  }
  if (!owner) {
    return {
      classification:
        heartbeatAgeMs <= options.initializingGraceMs
          ? "initializing"
          : "stale-safe",
      reason:
        heartbeatAgeMs <= options.initializingGraceMs
          ? "metadata-incomplete"
          : "metadata-invalid",
      ...common,
    };
  }

  const liveness = await safeLiveness(
    options.dependencies.processInspector,
    owner.pid,
  );
  if (liveness === "dead") {
    return {
      classification: "stale-safe",
      reason: "owner-dead",
      metadata: owner,
      ...common,
    };
  }
  if (owner.version === 0) {
    return {
      classification: "ambiguous",
      reason:
        liveness === "alive"
          ? "legacy-owner-live"
          : "legacy-owner-unknown",
      metadata: owner,
      ...common,
    };
  }
  if (liveness === "unknown") {
    return {
      classification: "ambiguous",
      reason: "owner-unknown",
      metadata: owner,
      ...common,
    };
  }

  const observedExecutable = await safeExecutablePath(
    options.dependencies.processInspector,
    owner.pid,
  );
  if (!observedExecutable) {
    return {
      classification: "ambiguous",
      reason: "executable-unknown",
      metadata: owner,
      ...common,
    };
  }
  if (!(await sameExecutable(owner.execPath, observedExecutable))) {
    return {
      classification: "stale-safe",
      reason: "executable-mismatch",
      metadata: owner,
      ...common,
    };
  }
  if (
    owner.workspaceId !== options.workspaceId ||
    owner.workspacePath !== options.workspacePath
  ) {
    return {
      classification: "ambiguous",
      reason: "workspace-mismatch",
      metadata: owner,
      ...common,
    };
  }
  if (heartbeatAgeMs < -MAX_FUTURE_HEARTBEAT_SKEW_MS) {
    return {
      classification: "ambiguous",
      reason: "heartbeat-in-future",
      metadata: owner,
      ...common,
    };
  }
  if (heartbeatAgeMs > options.staleAfterMs) {
    return {
      classification: "ambiguous",
      reason: "heartbeat-stale",
      metadata: owner,
      ...common,
    };
  }
  return {
    classification: "active",
    reason: "owner-active",
    metadata: owner,
    ...common,
  };
}

async function observeLock(lockPath: string): Promise<ObservedLock | undefined> {
  let stats: Stats;
  try {
    stats = await lstat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const identity = fileIdentity(stats);
  const syntheticLockId = syntheticId(identity);
  if (!stats.isFile() || stats.size > MAX_LOCK_BYTES) {
    return { stats, identity, lockId: syntheticLockId };
  }

  let handle: FileHandle | undefined;
  try {
    const noFollow =
      typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(lockPath, constants.O_RDONLY | noFollow);
    const openedStats = await handle.stat();
    if (!sameIdentity(identity, fileIdentity(openedStats))) {
      throw new Error("Workspace lock changed while it was being inspected.");
    }
    const content = await handle.readFile({ encoding: "utf8" });
    const parsed = parseLockOwner(content, identity);
    return {
      stats: openedStats,
      identity,
      lockId: parsed?.lockId ?? syntheticLockId,
      ...(parsed?.metadata === undefined ? {} : { metadata: parsed.metadata }),
      ...(parsed?.unknownVersion === true ? { unknownVersion: true } : {}),
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseLockOwner(
  content: string,
  identity: WorkspaceLockFileIdentity,
): ParsedLockOwner | undefined {
  const trimmed = content.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const pid = Number.parseInt(trimmed, 10);
    if (!validPid(pid)) return undefined;
    return {
      metadata: { version: 0, pid },
      lockId: syntheticId(identity),
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !validPid(value.pid)) return undefined;

  if (value.version === WORKSPACE_LOCK_VERSION) {
    if (
      !validShortString(value.lockId, 128) ||
      !validIsoTimestamp(value.bootTimestamp) ||
      !validPath(value.execPath) ||
      !validShortString(value.agentVersion, 128) ||
      !validShortString(value.workspaceId, 256) ||
      !validPath(value.workspacePath) ||
      !validIsoTimestamp(value.createdAt)
    ) {
      return undefined;
    }
    const metadata: WorkspaceLockMetadataV1 = {
      version: WORKSPACE_LOCK_VERSION,
      lockId: value.lockId,
      pid: value.pid,
      bootTimestamp: value.bootTimestamp,
      execPath: value.execPath,
      agentVersion: value.agentVersion,
      workspaceId: value.workspaceId,
      workspacePath: value.workspacePath,
      createdAt: value.createdAt,
    };
    return { metadata, lockId: metadata.lockId };
  }

  if (value.version !== undefined && value.version !== 0) {
    return {
      lockId: validShortString(value.lockId, 128)
        ? value.lockId
        : syntheticId(identity),
      unknownVersion: true,
    };
  }
  const nonce = validShortString(value.nonce, 128) ? value.nonce : undefined;
  const workspaceId = validShortString(value.workspaceId, 256)
    ? value.workspaceId
    : undefined;
  const createdAt = validIsoTimestamp(value.createdAt)
    ? value.createdAt
    : undefined;
  const metadata: LegacyWorkspaceLockMetadata = {
    version: 0,
    pid: value.pid,
    ...(nonce === undefined ? {} : { nonce }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(createdAt === undefined ? {} : { createdAt }),
  };
  return {
    metadata,
    lockId: nonce ?? syntheticId(identity),
  };
}

async function safeLiveness(
  inspector: ProcessInspector,
  pid: number,
): Promise<ProcessLiveness> {
  try {
    return await inspector.liveness(pid);
  } catch {
    return "unknown";
  }
}

async function safeExecutablePath(
  inspector: ProcessInspector,
  pid: number,
): Promise<string | undefined> {
  try {
    return await inspector.executablePath(pid);
  } catch {
    return undefined;
  }
}

async function sameExecutable(
  expectedPath: string,
  observedPath: string,
): Promise<boolean> {
  const expected = await canonicalizeExecutable(expectedPath);
  if (!isAbsolute(observedPath)) {
    return basename(expected) === basename(observedPath);
  }
  const observed = await canonicalizeExecutable(observedPath);
  return expected === observed;
}

async function acquireGuard(
  options: ResolvedWorkspaceLockOptions,
): Promise<GuardHandle> {
  const guardPath = guardPathFor(options.lockPath);
  const maximumAttempts =
    Math.ceil(options.guardTimeoutMs / options.guardRetryMs) + 1;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      const handle = await open(guardPath, "wx", 0o600);
      const guardId = randomUUID();
      const createdAt = new Date(options.dependencies.now()).toISOString();
      const openedStats = await handle.stat();
      const identity = fileIdentity(openedStats);
      try {
        await handle.writeFile(
          `${JSON.stringify({
            version: 1,
            guardId,
            pid: options.pid,
            createdAt,
          })}\n`,
          "utf8",
        );
        await handle.sync();
        return { handle, guardId, identity };
      } catch (error) {
        await handle.close().catch(() => undefined);
        if (await pathIdentityMatches(guardPath, identity)) {
          await unlink(guardPath).catch(() => undefined);
        }
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    await recoverStaleGuard(options).catch(() => undefined);
    if (attempt + 1 < maximumAttempts) {
      await options.dependencies.sleep(options.guardRetryMs);
    }
  }
  throw new WorkspaceLockGuardTimeoutError();
}

async function recoverStaleGuard(
  options: ResolvedWorkspaceLockOptions,
): Promise<void> {
  const guardPath = guardPathFor(options.lockPath);
  let stats: Stats;
  try {
    stats = await lstat(guardPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (options.dependencies.now() - stats.mtimeMs <= options.guardStaleAfterMs) {
    return;
  }
  const identity = fileIdentity(stats);
  let pid: number | undefined;
  if (stats.isFile() && stats.size <= MAX_LOCK_BYTES) {
    try {
      const handle = await open(guardPath, constants.O_RDONLY);
      try {
        const value = JSON.parse(
          await handle.readFile({ encoding: "utf8" }),
        ) as { pid?: unknown };
        if (validPid(value.pid)) pid = value.pid;
      } finally {
        await handle.close();
      }
    } catch {
      // An old invalid guard is removable after its full stale interval.
    }
  }
  if (
    pid !== undefined &&
    (await safeLiveness(options.dependencies.processInspector, pid)) !== "dead"
  ) {
    return;
  }
  if (await pathIdentityMatches(guardPath, identity)) {
    await unlink(guardPath).catch(() => undefined);
  }
}

async function releaseGuard(
  options: ResolvedWorkspaceLockOptions,
  guard: GuardHandle,
): Promise<void> {
  const guardPath = guardPathFor(options.lockPath);
  let firstError: unknown;
  try {
    if (
      (await pathIdentityMatches(guardPath, guard.identity)) &&
      (await readGuardId(guardPath)) === guard.guardId
    ) {
      await unlink(guardPath);
    }
  } catch (error) {
    firstError = error;
  }
  try {
    await guard.handle.close();
  } catch (error) {
    firstError ??= error;
  }
  if (firstError !== undefined) throw firstError;
}

async function readGuardId(path: string): Promise<string | undefined> {
  try {
    const handle = await open(path, constants.O_RDONLY);
    try {
      const value = JSON.parse(
        await handle.readFile({ encoding: "utf8" }),
      ) as { guardId?: unknown };
      return typeof value.guardId === "string" ? value.guardId : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

async function removeObservedLock(
  lockPath: string,
  observation: ObservedLock,
): Promise<boolean> {
  if (!(await pathIdentityMatches(lockPath, observation.identity))) return false;
  const current = await observeLock(lockPath);
  if (
    !current ||
    current.lockId !== observation.lockId ||
    !sameIdentity(current.identity, observation.identity)
  ) {
    return false;
  }
  await unlink(lockPath);
  return true;
}

async function assertLeaseFileOwnership(
  lockPath: string,
  identity: WorkspaceLockFileIdentity,
  lockId: string,
): Promise<void> {
  if (!(await lockFileMatches(lockPath, identity, lockId))) {
    throw new WorkspaceLeaseLostError(lockId);
  }
}

async function lockFileMatches(
  lockPath: string,
  identity: WorkspaceLockFileIdentity,
  lockId: string,
): Promise<boolean> {
  const current = await observeLock(lockPath).catch(() => undefined);
  return Boolean(
    current &&
      current.lockId === lockId &&
      sameIdentity(current.identity, identity),
  );
}

async function pathIdentityMatches(
  path: string,
  identity: WorkspaceLockFileIdentity,
): Promise<boolean> {
  try {
    return sameIdentity(fileIdentity(await lstat(path)), identity);
  } catch {
    return false;
  }
}

function fileIdentity(stats: Stats): WorkspaceLockFileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(
  left: WorkspaceLockFileIdentity | undefined,
  right: WorkspaceLockFileIdentity | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left.dev === right.dev &&
      left.ino === right.ino,
  );
}

function syntheticId(identity: WorkspaceLockFileIdentity): string {
  return `legacy:${identity.dev.toString(16)}:${identity.ino.toString(16)}`;
}

function guardPathFor(lockPath: string): string {
  return `${lockPath}.guard`;
}

function validPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validShortString(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength
  );
}

function validIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

function validPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !value.includes("\0") &&
    isAbsolute(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
