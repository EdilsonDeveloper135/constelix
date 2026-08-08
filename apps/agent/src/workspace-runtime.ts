import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import type { LspAvailability, WorkspaceSession } from "@constelix/contracts";

import { AskService, type AskServiceOptions } from "./ask.js";
import { CodexManager, type CodexManagerOptions } from "./codex.js";
import { ConstelixDatabase } from "./database.js";
import { EventBus } from "./events.js";
import { WorkspaceIndexer } from "./indexer.js";
import { LlmConfigurationStore } from "./llm-config.js";
import { LspManager } from "./lsp.js";
import type { ScanWorkspaceOptions } from "./scanner.js";
import {
  WorkspaceValidationError,
  assertWorkspaceIdentity,
  inspectWorkspace,
  redactLocalPaths,
  redactSecrets,
  summarizeWorkspacePath,
  type WorkspaceDescriptor,
} from "./security.js";
import { TerminalManager } from "./terminals.js";
import { WorkspaceLease } from "./workspace-lock.js";

export interface WorkspaceRuntimeOptions {
  workspaceRoot: string;
  readOnly?: boolean;
  storageDirectory?: string;
  databasePath?: string;
  askOptions?: AskServiceOptions;
  codexOptions?: CodexManagerOptions;
  indexerScanOptions?: Omit<ScanWorkspaceOptions, "onProgress">;
  agentVersion?: string;
  lockForce?: { expectedLockId: string };
}

export class WorkspaceRuntime {
  readonly workspace: WorkspaceDescriptor;
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly session: WorkspaceSession;
  readonly storageDirectory: string;
  readonly lease: WorkspaceLease;
  readonly database: ConstelixDatabase;
  readonly events: EventBus;
  readonly indexer: WorkspaceIndexer;
  readonly terminals: TerminalManager;
  readonly llmConfigurationStore: LlmConfigurationStore;
  readonly ask: AskService;
  readonly codex: CodexManager | undefined;
  readonly lsp: LspManager;

  #identityMonitor: NodeJS.Timeout | undefined;
  #identityCheckPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #started = false;
  #failed = false;
  #closing = false;

  private constructor(resources: {
    workspace: WorkspaceDescriptor;
    storageDirectory: string;
    lease: WorkspaceLease;
    database: ConstelixDatabase;
    events: EventBus;
    indexer: WorkspaceIndexer;
    terminals: TerminalManager;
    llmConfigurationStore: LlmConfigurationStore;
    ask: AskService;
    codex?: CodexManager;
    lsp: LspManager;
  }) {
    this.workspace = resources.workspace;
    this.workspaceRoot = resources.workspace.canonicalRoot;
    this.workspaceId = resources.workspace.workspaceId;
    this.session = {
      id: randomUUID(),
      workspaceId: this.workspaceId,
      activatedAt: new Date().toISOString(),
    };
    this.storageDirectory = resources.storageDirectory;
    this.lease = resources.lease;
    this.database = resources.database;
    this.events = resources.events;
    this.indexer = resources.indexer;
    this.terminals = resources.terminals;
    this.llmConfigurationStore = resources.llmConfigurationStore;
    this.ask = resources.ask;
    this.codex = resources.codex;
    this.lsp = resources.lsp;
  }

  static async create(
    options: WorkspaceRuntimeOptions,
  ): Promise<WorkspaceRuntime> {
    const workspace = await inspectWorkspace(options.workspaceRoot, {
      forceReadOnly: options.readOnly,
    });
    const workspaceRoot = workspace.canonicalRoot;
    const workspaceId = workspace.workspaceId;
    const storageDirectory =
      options.storageDirectory ??
      resolve(
        homedir(),
        "Library",
        "Application Support",
        "Constelix",
        "workspaces",
        workspaceId,
      );
    assertStatePathOutsideWorkspace(
      workspaceRoot,
      storageDirectory,
      "storageDirectory",
    );
    if (options.databasePath && options.databasePath !== ":memory:") {
      assertStatePathOutsideWorkspace(
        workspaceRoot,
        options.databasePath,
        "databasePath",
      );
    }
    await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
    await chmod(storageDirectory, 0o700);

    let runtime: WorkspaceRuntime | undefined;
    let lease: WorkspaceLease | undefined;
    let database: ConstelixDatabase | undefined;
    let events: EventBus | undefined;
    let indexer: WorkspaceIndexer | undefined;
    let terminals: TerminalManager | undefined;
    let ask: AskService | undefined;
    let codex: CodexManager | undefined;
    let lsp: LspManager | undefined;
    try {
      lease = await WorkspaceLease.acquire({
        lockPath: resolve(storageDirectory, "agent.lock"),
        workspaceId,
        workspacePath: workspaceRoot,
        agentVersion: options.agentVersion ?? "v0.0.7",
        ...(options.lockForce ? { force: options.lockForce } : {}),
        onLost: (error) => runtime?.handleIsolationFailure(error),
      });
      database = new ConstelixDatabase(
        options.databasePath ?? resolve(storageDirectory, "constelix.sqlite"),
      );
      database.upsertWorkspace(workspaceId, workspaceRoot);
      events = new EventBus((payload) =>
        sanitizeRuntimePayload(payload, workspaceRoot)
      );
      indexer = new WorkspaceIndexer(
        workspaceId,
        workspace,
        database,
        events,
        {
          assertWorkspace: async () => {
            await assertWorkspaceIdentity(workspace);
            await lease?.assertOwned();
          },
          ...(options.indexerScanOptions === undefined
            ? {}
            : { scanOptions: options.indexerScanOptions }),
        },
      );
      terminals = new TerminalManager(workspace, events);
      const llmConfigurationStore = new LlmConfigurationStore(
        storageDirectory,
      );
      const llmConfiguration = await llmConfigurationStore.load();
      ask = new AskService(
        workspaceId,
        workspace,
        indexer.graph,
        database,
        events,
        {
          configuration: llmConfiguration,
          ...options.askOptions,
        },
      );
      if (!workspace.readOnly) {
        codex = new CodexManager(
          workspaceId,
          workspace,
          events,
          database,
          options.codexOptions,
        );
      }
      lsp = new LspManager({ workspaceRoot, workspaceId });
      runtime = new WorkspaceRuntime({
        workspace,
        storageDirectory,
        lease,
        database,
        events,
        indexer,
        terminals,
        llmConfigurationStore,
        ask,
        ...(codex ? { codex } : {}),
        lsp,
      });
      return runtime;
    } catch (error) {
      await cleanupRuntimeResources({
        ask,
        codex,
        terminals,
        lsp,
        indexer,
        events,
        database,
        lease,
      }).catch(() => undefined);
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.#started) return;
    await this.assertHealthy();
    try {
      await this.indexer.start();
      await this.assertHealthy();
      this.#started = true;
      this.#identityMonitor = this.startIdentityMonitor();
      if (this.codex) void this.codex.availability();
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  async assertHealthy(): Promise<void> {
    if (this.#failed) {
      throw new WorkspaceValidationError(
        "WORKSPACE_VALIDATION_FAILED",
        "La sesión del workspace perdió su aislamiento.",
      );
    }
    await assertWorkspaceIdentity(this.workspace);
    await this.lease.assertOwned();
  }

  availability(): LspAvailability {
    const availability = this.lsp.availability();
    return {
      javascript: publicLspStatus(availability.javascript),
      typescript: publicLspStatus(availability.typescript),
      python: publicLspStatus(availability.python),
    };
  }

  close(): Promise<void> {
    this.#closePromise ??= this.closeOnce();
    return this.#closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.#closing = true;
    if (this.#identityMonitor) {
      clearInterval(this.#identityMonitor);
      this.#identityMonitor = undefined;
    }
    await this.#identityCheckPromise?.catch(() => undefined);
    await cleanupRuntimeResources({
      ask: this.ask,
      codex: this.codex,
      terminals: this.terminals,
      lsp: this.lsp,
      indexer: this.indexer,
      events: this.events,
      database: this.database,
      lease: this.lease,
    });
  }

  private startIdentityMonitor(): NodeJS.Timeout {
    const timer = setInterval(() => {
      if (this.#identityCheckPromise || this.#failed || this.#closing) return;
      const check = this.assertHealthy()
        .catch((error) => {
          if (!this.#closing) this.handleIsolationFailure(error);
        })
        .finally(() => {
          if (this.#identityCheckPromise === check) {
            this.#identityCheckPromise = undefined;
          }
        });
      this.#identityCheckPromise = check;
    }, 500);
    timer.unref();
    return timer;
  }

  private handleIsolationFailure(error: unknown): void {
    if (this.#failed || this.#closing) return;
    this.#failed = true;
    if (error instanceof Error) {
      try {
        this.database.audit(
          this.workspaceId,
          "workspace",
          "isolation-lost",
          "failed",
          {
            message: redactLocalPaths(
              redactSecrets(error.message),
              this.workspaceRoot,
            ),
          },
        );
      } catch {
        // Isolation teardown must continue even if its best-effort audit fails.
      }
    }
    try {
      this.events.publish("error", {
        code: "WORKSPACE_ISOLATION_LOST",
        message:
          "La raíz o la lease del workspace cambió. Se detuvieron procesos, IA, LSP e indexación.",
        recoverable: false,
        severity: "error",
      });
    } catch {
      // A disconnected event consumer must never prevent fail-closed teardown.
    }
    void this.close().catch(() => undefined);
  }
}

async function cleanupRuntimeResources(resources: {
  ask: AskService | undefined;
  codex: CodexManager | undefined;
  terminals: TerminalManager | undefined;
  lsp: LspManager | undefined;
  indexer: WorkspaceIndexer | undefined;
  events: EventBus | undefined;
  database: ConstelixDatabase | undefined;
  lease: WorkspaceLease | undefined;
}): Promise<void> {
  let firstError: unknown;
  const attempt = async (action: () => void | Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      firstError ??= error;
    }
  };
  await attempt(() => resources.ask?.close());
  await attempt(() => resources.codex?.close());
  await attempt(() => resources.terminals?.close());
  await attempt(async () => resources.lsp?.close());
  await attempt(async () => resources.indexer?.close());
  await attempt(() => resources.database?.close());
  await attempt(async () => resources.lease?.release());
  await attempt(() => resources.events?.close());
  if (firstError !== undefined) throw firstError;
}

function publicLspStatus(status: {
  available: boolean;
  reason?: string;
}): { available: boolean; reason?: string } {
  return {
    available: status.available,
    ...(status.reason ? { reason: status.reason } : {}),
  };
}

function sanitizeRuntimePayload(
  value: unknown,
  workspaceRoot: string,
): unknown {
  if (typeof value === "string") {
    return redactLocalPaths(redactSecrets(value), workspaceRoot);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRuntimePayload(item, workspaceRoot));
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sanitizeRuntimePayload(item, workspaceRoot),
    ]),
  );
}

export function assertStatePathOutsideWorkspace(
  workspaceRoot: string,
  candidatePath: string,
  label: string,
): void {
  const projected = projectCanonicalPath(resolve(candidatePath));
  if (isPathWithin(workspaceRoot, projected)) {
    throw new WorkspaceValidationError(
      "WORKSPACE_VALIDATION_FAILED",
      `${label} debe estar fuera del workspace.`,
    );
  }
}

function projectCanonicalPath(candidatePath: string): string {
  let cursor = candidatePath;
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix);
}

function isPathWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (!isAbsolute(fromRoot) &&
      fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`))
  );
}

export function defaultConstelixStateRoot(): string {
  return resolve(
    homedir(),
    "Library",
    "Application Support",
    "Constelix",
  );
}

export function workspaceDisplayName(runtime: WorkspaceRuntime): string {
  return basename(runtime.workspaceRoot);
}

export function workspaceDisplayPath(runtime: WorkspaceRuntime): string {
  return summarizeWorkspacePath(runtime.workspaceRoot);
}
