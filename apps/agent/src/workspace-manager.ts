import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  ClientEvent,
  RecentWorkspace,
  WorkspaceLockResolution,
  WorkspaceSession,
  WorkspaceTarget,
} from "@constelix/contracts";

import { EventBus } from "./events.js";
import {
  createWorkspaceId,
  inspectWorkspace,
} from "./security.js";
import {
  WorkspaceBrowser,
  type WorkspaceBrowseInput,
  type WorkspaceBrowsePage,
} from "./workspace-browser.js";
import {
  WorkspaceCatalog,
  type WorkspaceCatalogRecord,
} from "./workspace-catalog.js";
import {
  WorkspaceRuntime,
  assertStatePathOutsideWorkspace,
  defaultConstelixStateRoot,
  type WorkspaceRuntimeOptions,
} from "./workspace-runtime.js";
import {
  WorkspaceLockConflictError,
  inspectWorkspaceLock,
  type WorkspaceLockInspection,
} from "./workspace-lock.js";

export class WorkspaceSessionChangedError extends Error {
  readonly code = "WORKSPACE_SESSION_CHANGED";

  constructor(readonly activeSession: WorkspaceSession) {
    super("La operación pertenece a una sesión de workspace anterior.");
    this.name = "WorkspaceSessionChangedError";
  }
}

export class WorkspaceSwitchInProgressError extends Error {
  readonly code = "WORKSPACE_SWITCH_IN_PROGRESS";

  constructor() {
    super("Ya hay un cambio de workspace en curso.");
    this.name = "WorkspaceSwitchInProgressError";
  }
}

export class RecentWorkspaceNotFoundError extends Error {
  readonly code = "WORKSPACE_NOT_FOUND";

  constructor() {
    super("El workspace reciente ya no está disponible.");
    this.name = "RecentWorkspaceNotFoundError";
  }
}

export class WorkspaceOpenLockConflictError extends Error {
  readonly code = "WORKSPACE_LOCK_CONFLICT";

  constructor(
    readonly workspaceId: string,
    readonly workspacePath: string,
    readonly inspection: WorkspaceLockInspection,
  ) {
    super(
      inspection.classification === "active"
        ? "El workspace ya está abierto por otra instancia activa de Constelix."
        : "El lock del workspace requiere una resolución explícita.",
    );
    this.name = "WorkspaceOpenLockConflictError";
  }
}

export interface WorkspaceManagerOptions
  extends Omit<WorkspaceRuntimeOptions, "workspaceRoot" | "lockForce"> {
  workspaceRoot: string;
  globalDatabasePath?: string;
}

export class WorkspaceRuntimeManager {
  readonly globalEvents: EventBus;
  readonly catalog: WorkspaceCatalog;
  readonly browser: WorkspaceBrowser;

  #current: WorkspaceRuntime;
  #switching = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #unsubscribeClient: (() => void) | undefined;
  readonly #runtimeUnsubscribers = new Map<string, () => void>();

  private constructor(
    private readonly options: WorkspaceManagerOptions,
    runtime: WorkspaceRuntime,
    globalEvents: EventBus,
    catalog: WorkspaceCatalog,
    browser: WorkspaceBrowser,
  ) {
    this.#current = runtime;
    this.globalEvents = globalEvents;
    this.catalog = catalog;
    this.browser = browser;
    this.bindRuntime(runtime);
    this.#unsubscribeClient = globalEvents.onClientMessage((message) => {
      this.#current.events.dispatchClientMessage(message);
    });
    this.recordCurrent();
  }

  static async create(
    options: WorkspaceManagerOptions,
  ): Promise<WorkspaceRuntimeManager> {
    const initialWorkspace = await inspectWorkspace(options.workspaceRoot, {
      forceReadOnly: options.readOnly,
    });
    const stateRoot = options.storageDirectory
      ? dirname(options.storageDirectory)
      : defaultConstelixStateRoot();
    const globalDatabasePath =
      options.globalDatabasePath ?? resolve(stateRoot, "global.sqlite");
    assertManagerStateOutsideWorkspace(
      options,
      initialWorkspace.canonicalRoot,
    );
    const globalEvents = new EventBus();
    const catalog = new WorkspaceCatalog(globalDatabasePath);
    const browser = new WorkspaceBrowser();
    let runtime: WorkspaceRuntime | undefined;
    try {
      runtime = await WorkspaceRuntime.create(options);
      await runtime.start();
      return new WorkspaceRuntimeManager(
        options,
        runtime,
        globalEvents,
        catalog,
        browser,
      );
    } catch (error) {
      await runtime?.close().catch(() => undefined);
      globalEvents.close();
      catalog.close();
      throw error;
    }
  }

  get current(): WorkspaceRuntime {
    return this.#current;
  }

  capture(expectedSessionId?: string): WorkspaceRuntime {
    if (this.#switching) throw new WorkspaceSwitchInProgressError();
    const runtime = this.#current;
    if (
      expectedSessionId &&
      expectedSessionId !== runtime.session.id
    ) {
      throw new WorkspaceSessionChangedError(runtime.session);
    }
    return runtime;
  }

  async open(input: {
    target: WorkspaceTarget;
    expectedSessionId: string;
    readOnly?: boolean;
    lockResolution?: WorkspaceLockResolution;
  }): Promise<WorkspaceRuntime> {
    if (this.#closed) throw new Error("Workspace manager is closed.");
    if (this.#switching) throw new WorkspaceSwitchInProgressError();
    const previous = this.#current;
    if (input.expectedSessionId !== previous.session.id) {
      throw new WorkspaceSessionChangedError(previous.session);
    }
    this.#switching = true;
    let candidate: WorkspaceRuntime | undefined;
    try {
      const targetPath = this.resolveTarget(input.target);
      const descriptor = await inspectWorkspace(targetPath, {
        forceReadOnly: input.readOnly === true || this.options.readOnly === true,
      });
      assertManagerStateOutsideWorkspace(
        this.options,
        descriptor.canonicalRoot,
      );
      if (descriptor.workspaceId === previous.workspaceId) {
        return previous;
      }
      try {
        candidate = await WorkspaceRuntime.create(
          this.runtimeOptionsForSwitch(
            descriptor.canonicalRoot,
            descriptor.readOnly,
            input.lockResolution,
          ),
        );
      } catch (error) {
        if (error instanceof WorkspaceLockConflictError) {
          throw new WorkspaceOpenLockConflictError(
            descriptor.workspaceId,
            descriptor.canonicalRoot,
            error.inspection,
          );
        }
        throw error;
      }
      this.bindRuntime(candidate);
      await candidate.start();

      this.recordRuntime(candidate);
      this.#current = candidate;
      try {
        await previous.close();
      } catch (error) {
        this.auditCommittedSwitchWarning(
          candidate,
          "previous-runtime-cleanup",
          error,
        );
      } finally {
        this.unbindRuntime(previous);
      }
      // The notification is the public commit boundary. Release the
      // transition barrier only after the prior runtime is fully detached so
      // another tab can bootstrap the announced session immediately.
      this.#switching = false;
      try {
        this.globalEvents.publish(
          "workspace.changed",
          { session: candidate.session },
          {
            sessionId: candidate.session.id,
            workspaceId: candidate.workspaceId,
          },
        );
      } catch (error) {
        this.auditCommittedSwitchWarning(
          candidate,
          "workspace-change-notification",
          error,
        );
      }
      return candidate;
    } catch (error) {
      if (candidate && candidate !== this.#current) {
        await candidate.close().catch(() => undefined);
        this.unbindRuntime(candidate);
      }
      throw error;
    } finally {
      this.#switching = false;
    }
  }

  listRecentWorkspaces(): Promise<RecentWorkspace[]> {
    return Promise.all(
      this.catalog.listRecentWorkspaces().map(async (workspace) => ({
        protocolVersion: 1 as const,
        workspaceId: workspace.workspaceId,
        name: workspace.name,
        displayPath: workspace.displayPath,
        lastOpenedAt: workspace.lastOpenedAt,
        availability:
          workspace.workspaceId === this.#current.workspaceId
            ? "available" as const
            : await workspaceAvailability(
                this.catalog.lookupWorkspace(workspace.workspaceId),
                this.storageDirectoryFor(workspace.workspaceId),
              ),
        lastMode: workspace.mode,
      })),
    );
  }

  browse(input: WorkspaceBrowseInput): Promise<WorkspaceBrowsePage> {
    return this.browser.browse(input);
  }

  dispatchClientMessage(message: ClientEvent): void {
    this.#current.events.dispatchClientMessage(message);
  }

  close(): Promise<void> {
    this.#closePromise ??= this.closeOnce();
    return this.#closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.#closed = true;
    this.#unsubscribeClient?.();
    this.#unsubscribeClient = undefined;
    let firstError: unknown;
    try {
      await this.#current.close();
    } catch (error) {
      firstError = error;
    } finally {
      this.unbindRuntime(this.#current);
      try {
        this.catalog.close();
      } catch (error) {
        firstError ??= error;
      }
      try {
        this.globalEvents.close();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  private bindRuntime(runtime: WorkspaceRuntime): void {
    if (this.#runtimeUnsubscribers.has(runtime.session.id)) return;
    const unsubscribe = runtime.events.subscribe((event) => {
      if (this.#current !== runtime) return;
      try {
        this.globalEvents.publish(event.type, event.payload, {
          sessionId: runtime.session.id,
          workspaceId: runtime.workspaceId,
        });
      } catch (error) {
        this.auditCommittedSwitchWarning(
          runtime,
          "event-forward",
          error,
        );
      }
    });
    this.#runtimeUnsubscribers.set(runtime.session.id, unsubscribe);
  }

  private unbindRuntime(runtime: WorkspaceRuntime): void {
    this.#runtimeUnsubscribers.get(runtime.session.id)?.();
    this.#runtimeUnsubscribers.delete(runtime.session.id);
  }

  private resolveTarget(target: WorkspaceTarget): string {
    if (target.kind === "path") return target.path;
    const recent = this.catalog.lookupWorkspace(target.workspaceId);
    if (!recent) throw new RecentWorkspaceNotFoundError();
    return recent.canonicalRoot;
  }

  private runtimeOptionsForSwitch(
    workspaceRoot: string,
    readOnly: boolean | undefined,
    lockResolution: WorkspaceLockResolution | undefined,
  ): WorkspaceRuntimeOptions {
    const workspaceId = createWorkspaceId(workspaceRoot);
    const storageDirectory = this.options.storageDirectory
      ? this.storageDirectoryFor(workspaceId)
      : undefined;
    const databasePath =
      this.options.databasePath === ":memory:"
        ? ":memory:"
        : this.options.databasePath
          ? resolve(
              dirname(this.options.databasePath),
              `${workspaceId}.sqlite`,
            )
          : undefined;
    const effectiveReadOnly =
      readOnly === true || this.options.readOnly === true;
    return {
      workspaceRoot,
      readOnly: effectiveReadOnly,
      ...(storageDirectory ? { storageDirectory } : {}),
      ...(databasePath ? { databasePath } : {}),
      ...(this.options.askOptions ? { askOptions: this.options.askOptions } : {}),
      ...(this.options.codexOptions
        ? { codexOptions: this.options.codexOptions }
        : {}),
      ...(this.options.indexerScanOptions
        ? { indexerScanOptions: this.options.indexerScanOptions }
        : {}),
      ...(this.options.agentVersion
        ? { agentVersion: this.options.agentVersion }
        : {}),
      ...(lockResolution
        ? { lockForce: { expectedLockId: lockResolution.expectedLockId } }
        : {}),
    };
  }

  private recordCurrent(): void {
    this.recordRuntime(this.#current);
  }

  private recordRuntime(runtime: WorkspaceRuntime): void {
    this.catalog.recordOpenedWorkspace({
      workspaceId: runtime.workspaceId,
      canonicalRoot: runtime.workspaceRoot,
      mode: runtime.workspace.mode,
    });
  }

  private auditCommittedSwitchWarning(
    runtime: WorkspaceRuntime,
    action: string,
    error: unknown,
  ): void {
    try {
      runtime.database.audit(
        runtime.workspaceId,
        "workspace",
        action,
        "failed",
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
      );
    } catch {
      // A committed candidate must remain usable even if warning audit fails.
    }
  }

  private storageDirectoryFor(workspaceId: string): string {
    return this.options.storageDirectory
      ? resolve(dirname(this.options.storageDirectory), workspaceId)
      : resolve(defaultConstelixStateRoot(), "workspaces", workspaceId);
  }
}

function assertManagerStateOutsideWorkspace(
  options: WorkspaceManagerOptions,
  workspaceRoot: string,
): void {
  const stateRoot = options.storageDirectory
    ? dirname(options.storageDirectory)
    : defaultConstelixStateRoot();
  const globalDatabasePath =
    options.globalDatabasePath ?? resolve(stateRoot, "global.sqlite");
  if (options.storageDirectory) {
    assertStatePathOutsideWorkspace(
      workspaceRoot,
      options.storageDirectory,
      "storageDirectory",
    );
  }
  if (options.databasePath && options.databasePath !== ":memory:") {
    assertStatePathOutsideWorkspace(
      workspaceRoot,
      options.databasePath,
      "databasePath",
    );
  }
  assertStatePathOutsideWorkspace(workspaceRoot, stateRoot, "stateRoot");
  assertStatePathOutsideWorkspace(
    workspaceRoot,
    globalDatabasePath,
    "globalDatabasePath",
  );
}

async function workspaceAvailability(
  record: WorkspaceCatalogRecord | undefined,
  storageDirectory: string,
): Promise<"available" | "missing" | "unreadable" | "locked" | "unknown"> {
  if (!record) return "missing";
  try {
    await access(record.canonicalRoot);
    const lock = await inspectWorkspaceLock({
      lockPath: resolve(storageDirectory, "agent.lock"),
      workspaceId: record.workspaceId,
      workspacePath: record.canonicalRoot,
    });
    if (
      lock.classification === "active" ||
      lock.classification === "ambiguous" ||
      lock.classification === "initializing"
    ) {
      return "locked";
    }
    return "available";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    if (code === "EACCES" || code === "EPERM") return "unreadable";
    return "unknown";
  }
}
