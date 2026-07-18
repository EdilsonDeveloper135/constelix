import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CodexManager,
  TESTED_CODEX_VERSION,
  createCodexSandboxPolicy,
  type CodexManagerOptions,
} from "./codex.js";
import { EventBus, type LocalServerEvent } from "./events.js";
import type { ConstelixDatabase } from "./database.js";
import {
  WorkspaceIdentityError,
  inspectWorkspace,
} from "./security.js";

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

type SpawnedCodexProcess = ReturnType<
  NonNullable<CodexManagerOptions["spawnAppServer"]>
>;

class FakeCodexAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly clientMessages: RpcMessage[] = [];
  killed = false;
  interruptError: string | undefined;
  resumeError: string | undefined;
  holdInitialize = false;
  holdTurnStart = false;
  holdInterrupt = false;
  #stdinBuffer = "";
  #turnCounter = 0;
  #heldInitializeId: number | string | undefined;

  constructor() {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => this.consumeClientData(chunk));
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.emit("exit", null, signal);
    return true;
  }

  crash(message = "simulated app-server crash"): void {
    if (this.killed) return;
    this.killed = true;
    this.stderr.write(`${message}\n`);
    this.emit("exit", 1, null);
  }

  request(id: number | string, method: string, params: Record<string, unknown>): void {
    this.sendToClient({ id, method, params });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.sendToClient({ method, params });
  }

  response(id: number | string): RpcMessage | undefined {
    return this.clientMessages.find(
      (message) => message.id === id && message.method === undefined,
    );
  }

  releaseInitialize(): void {
    const id = this.#heldInitializeId;
    if (id === undefined) return;
    this.#heldInitializeId = undefined;
    this.sendToClient({
      id,
      result: { serverInfo: { name: "codex", version: TESTED_CODEX_VERSION } },
    });
  }

  private consumeClientData(chunk: string): void {
    this.#stdinBuffer += chunk;
    let newline = this.#stdinBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#stdinBuffer.slice(0, newline).trim();
      this.#stdinBuffer = this.#stdinBuffer.slice(newline + 1);
      if (line) this.consumeClientMessage(JSON.parse(line) as RpcMessage);
      newline = this.#stdinBuffer.indexOf("\n");
    }
  }

  private consumeClientMessage(message: RpcMessage): void {
    this.clientMessages.push(message);
    if (message.id === undefined || !message.method) return;

    switch (message.method) {
      case "initialize":
        if (this.holdInitialize) {
          this.#heldInitializeId = message.id;
          return;
        }
        this.sendToClient({
          id: message.id,
          result: { serverInfo: { name: "codex", version: TESTED_CODEX_VERSION } },
        });
        return;
      case "thread/start":
        this.sendToClient({
          id: message.id,
          result: { thread: { id: "thread-1" } },
        });
        return;
      case "thread/resume":
        if (this.resumeError) {
          this.sendToClient({
            id: message.id,
            error: { code: -32_000, message: this.resumeError },
          });
          return;
        }
        this.sendToClient({
          id: message.id,
          result: {
            thread: {
              id:
                typeof message.params?.threadId === "string"
                  ? message.params.threadId
                  : "thread-1",
            },
          },
        });
        return;
      case "turn/start":
        this.#turnCounter += 1;
        if (this.holdTurnStart) return;
        this.sendToClient({
          id: message.id,
          result: { turn: { id: `turn-${this.#turnCounter}` } },
        });
        return;
      case "turn/interrupt":
        if (this.holdInterrupt) return;
        if (this.interruptError) {
          this.sendToClient({
            id: message.id,
            error: { code: -32_000, message: this.interruptError },
          });
        } else {
          this.sendToClient({ id: message.id, result: {} });
        }
        return;
      default:
        this.sendToClient({
          id: message.id,
          error: { code: -32_601, message: `Unexpected method ${message.method}` },
        });
    }
  }

  private sendToClient(message: RpcMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

interface Harness {
  manager: CodexManager;
  appServer: FakeCodexAppServer;
  events: LocalServerEvent[];
  versionChecks(): number;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  vi.useRealTimers();
});

function createHarness(
  resumeThreadId?: string,
  inactivityTimeoutMs?: number,
  options: {
    appServers?: FakeCodexAppServer[];
    requestTimeoutMs?: number;
  } = {},
): Harness {
  const workspaceId = "workspace-1";
  const workspaceRoot = "/workspace";
  const database = {
    saveCodexTask: () => undefined,
    audit: () => undefined,
    loadLatestCodexThreadId: () => resumeThreadId,
  } as unknown as ConstelixDatabase;
  const eventBus = new EventBus();
  const publishedEvents: LocalServerEvent[] = [];
  const unsubscribe = eventBus.subscribe((event) => publishedEvents.push(event));
  const appServers = options.appServers ?? [new FakeCodexAppServer()];
  const appServer = appServers[0]!;
  let spawnIndex = 0;
  let checks = 0;
  const manager = new CodexManager(workspaceId, workspaceRoot, eventBus, database, {
    getCodexVersion: async () => {
      checks += 1;
      return TESTED_CODEX_VERSION;
    },
    spawnAppServer: () =>
      appServers[Math.min(spawnIndex++, appServers.length - 1)] as unknown as SpawnedCodexProcess,
    requestTimeoutMs: options.requestTimeoutMs ?? 1_000,
    ...(inactivityTimeoutMs === undefined ? {} : { inactivityTimeoutMs }),
  });

  cleanups.push(() => {
    manager.close();
    unsubscribe();
    eventBus.close();
  });
  return {
    manager,
    appServer,
    events: publishedEvents,
    versionChecks: () => checks,
  };
}

async function approveTask(harness: Harness) {
  const task = harness.manager.createTask("Update the internal workspace file.");
  return harness.manager.approve(task.id);
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for the Codex test condition.");
}

describe("createCodexSandboxPolicy", () => {
  it("keeps writes inside the workspace and excludes global temporary directories", () => {
    expect(createCodexSandboxPolicy("/workspace")).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/workspace"],
      networkAccess: true,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    });
  });
});

describe("CodexManager App Server protocol", () => {
  it("refuses approval after the canonical workspace root is replaced", async () => {
    const parent = await mkdtemp(join(tmpdir(), "constelix-codex-identity-"));
    const root = join(parent, "workspace");
    await mkdir(root);
    const workspace = await inspectWorkspace(root);
    const database = {
      saveCodexTask: () => undefined,
      audit: () => undefined,
      loadLatestCodexThreadId: () => undefined,
    } as unknown as ConstelixDatabase;
    const events = new EventBus();
    const spawnAppServer = vi.fn(
      () => new FakeCodexAppServer() as unknown as SpawnedCodexProcess,
    );
    const manager = new CodexManager(
      workspace.workspaceId,
      workspace,
      events,
      database,
      {
        getCodexVersion: async () => TESTED_CODEX_VERSION,
        spawnAppServer,
      },
    );
    try {
      const task = manager.createTask("Inspect the workspace.");
      await rename(root, join(parent, "workspace-original"));
      await mkdir(root);

      await expect(manager.approve(task.id)).rejects.toBeInstanceOf(
        WorkspaceIdentityError,
      );
      expect(manager.getTask(task.id)?.status).toBe("pending_approval");
      expect(spawnAppServer).not.toHaveBeenCalled();
    } finally {
      manager.close();
      events.close();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("disables Act when Codex is absent or incompatible", async () => {
    const database = {
      saveCodexTask: () => undefined,
      audit: () => undefined,
      loadLatestCodexThreadId: () => undefined,
    } as unknown as ConstelixDatabase;
    const absentEvents = new EventBus();
    const incompatibleEvents = new EventBus();
    const absent = new CodexManager(
      "workspace",
      "/workspace",
      absentEvents,
      database,
      { getCodexVersion: async () => undefined },
    );
    const incompatible = new CodexManager(
      "workspace",
      "/workspace",
      incompatibleEvents,
      database,
      { getCodexVersion: async () => "0.1.0" },
    );
    try {
      await expect(absent.availability()).resolves.toMatchObject({
        available: false,
      });
      await expect(incompatible.availability()).resolves.toEqual({
        available: false,
        version: "0.1.0",
        reason: `Constelix currently supports Codex CLI ${TESTED_CODEX_VERSION}.`,
      });
    } finally {
      absent.close();
      incompatible.close();
      absentEvents.close();
      incompatibleEvents.close();
    }
  });

  it("exposes a non-blocking availability snapshot and publishes the resolved capability", async () => {
    let resolveVersion: ((version: string) => void) | undefined;
    const version = new Promise<string>((resolve) => {
      resolveVersion = resolve;
    });
    const database = {
      saveCodexTask: () => undefined,
      audit: () => undefined,
      loadLatestCodexThreadId: () => undefined,
    } as unknown as ConstelixDatabase;
    const eventBus = new EventBus();
    const events: LocalServerEvent[] = [];
    const unsubscribe = eventBus.subscribe((event) => events.push(event));
    let checks = 0;
    const manager = new CodexManager(
      "workspace",
      "/workspace",
      eventBus,
      database,
      {
        getCodexVersion: async () => {
          checks += 1;
          return version;
        },
      },
    );
    try {
      expect(manager.peekAvailability()).toMatchObject({
        available: false,
        checking: true,
      });
      const first = manager.availability();
      const second = manager.availability();
      expect(checks).toBe(1);
      expect(manager.peekAvailability()).toMatchObject({
        available: false,
        checking: true,
      });

      resolveVersion?.(TESTED_CODEX_VERSION);
      await expect(Promise.all([first, second])).resolves.toEqual([
        { available: true, version: TESTED_CODEX_VERSION },
        { available: true, version: TESTED_CODEX_VERSION },
      ]);
      expect(checks).toBe(1);
      expect(manager.peekAvailability()).toEqual({
        available: true,
        version: TESTED_CODEX_VERSION,
        checking: false,
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "capabilities.updated",
          payload: {
            act: true,
            checking: false,
            codexVersion: TESTED_CODEX_VERSION,
          },
        }),
      );
    } finally {
      manager.close();
      unsubscribe();
      eventBus.close();
    }
  });

  it("waits for task approval, performs the handshake, and starts one scoped turn", async () => {
    const harness = createHarness();
    const pending = harness.manager.createTask("Refactor src/internal.ts.");

    expect(harness.appServer.clientMessages).toEqual([]);

    const task = await harness.manager.approve(pending.id);
    const methods = harness.appServer.clientMessages
      .filter((message) => message.method)
      .map((message) => message.method);

    expect(methods).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ]);
    expect(
      harness.appServer.clientMessages.find((message) => message.method === "initialized"),
    ).not.toHaveProperty("params");
    expect(
      harness.appServer.clientMessages.find((message) => message.method === "thread/start")?.params,
    ).toMatchObject({
      cwd: "/workspace",
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    expect(
      harness.appServer.clientMessages.find((message) => message.method === "turn/start")?.params,
    ).toMatchObject({
      threadId: "thread-1",
      approvalPolicy: "never",
      sandboxPolicy: createCodexSandboxPolicy("/workspace"),
    });
    expect(task).toMatchObject({
      status: "running",
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
    });
    expect(harness.manager.activeTask?.id).toBe(task.id);

    harness.appServer.notify("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed",
        error: null,
      },
    });

    expect(harness.manager.getTask(task.id)).toMatchObject({
      status: "completed",
      completedAt: expect.any(String),
    });
    expect(harness.manager.activeTask).toBeUndefined();
  });

  it("resumes the latest persisted thread only after a new task is approved", async () => {
    const harness = createHarness("thread-persisted");
    const pending = harness.manager.createTask("Continue the approved workspace task.");

    expect(harness.appServer.clientMessages).toEqual([]);

    const task = await harness.manager.approve(pending.id);
    const methods = harness.appServer.clientMessages
      .filter((message) => message.method)
      .map((message) => message.method);

    expect(methods).toEqual([
      "initialize",
      "initialized",
      "thread/resume",
      "turn/start",
    ]);
    expect(
      harness.appServer.clientMessages.find((message) => message.method === "thread/resume")?.params,
    ).toEqual({
      threadId: "thread-persisted",
      cwd: "/workspace",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      excludeTurns: true,
    });
    expect(task).toMatchObject({
      status: "running",
      codexThreadId: "thread-persisted",
    });
  });

  it("cancels an approved task before turn/start and rejects a concurrent approval", async () => {
    const harness = createHarness();
    harness.appServer.holdInitialize = true;
    const first = harness.manager.createTask("Start a delayed Codex task.");
    const second = harness.manager.createTask("Do not overlap the first task.");
    const approving = harness.manager.approve(first.id);

    await waitForCondition(() =>
      harness.appServer.clientMessages.some(
        (message) => message.method === "initialize",
      ),
    );
    await expect(harness.manager.approve(second.id)).rejects.toThrow(
      "Another Codex task is already active",
    );

    const cancellation = await harness.manager.cancel(first.id);
    expect(cancellation).toMatchObject({
      status: "approved",
      cancellationRequested: true,
    });
    harness.appServer.releaseInitialize();

    await expect(approving).resolves.toMatchObject({ status: "cancelled" });
    expect(
      harness.appServer.clientMessages.some(
        (message) => message.method === "turn/start",
      ),
    ).toBe(false);
  });

  it("terminates an ambiguous turn/start session before another task starts", async () => {
    const firstServer = new FakeCodexAppServer();
    firstServer.holdTurnStart = true;
    const secondServer = new FakeCodexAppServer();
    const harness = createHarness(undefined, undefined, {
      appServers: [firstServer, secondServer],
      requestTimeoutMs: 20,
    });
    const first = harness.manager.createTask("Start a turn whose acknowledgement is lost.");

    await expect(harness.manager.approve(first.id)).rejects.toThrow(
      "Codex request timed out: turn/start",
    );
    expect(firstServer.killed).toBe(true);
    expect(harness.manager.getTask(first.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("outcome of turn/start was ambiguous"),
    });

    const second = harness.manager.createTask("Start only after the old session exits.");
    await expect(harness.manager.approve(second.id)).resolves.toMatchObject({
      status: "running",
    });
    expect(
      firstServer.clientMessages.filter((message) => message.method === "turn/start"),
    ).toHaveLength(1);
    expect(
      secondServer.clientMessages.filter((message) => message.method === "turn/start"),
    ).toHaveLength(1);
  });

  it("cancels an approved task that remains inactive during App Server startup", async () => {
    vi.useFakeTimers();
    const harness = createHarness(undefined, 100);
    harness.appServer.holdInitialize = true;
    const task = harness.manager.createTask("Start a Codex task that stalls.");
    const approving = harness.manager.approve(task.id);

    await vi.advanceTimersByTimeAsync(0);
    expect(
      harness.appServer.clientMessages.some(
        (message) => message.method === "initialize",
      ),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(101);
    expect(harness.manager.getTask(task.id)).toMatchObject({
      status: "approved",
      cancellationRequested: true,
    });
    harness.appServer.releaseInitialize();

    await expect(approving).resolves.toMatchObject({
      status: "cancelled",
      completedAt: expect.any(String),
    });
  });

  it("resets the running-turn inactivity watchdog when Codex emits activity", async () => {
    vi.useFakeTimers();
    const harness = createHarness(undefined, 1_000);
    const task = await approveTask(harness);

    await vi.advanceTimersByTimeAsync(800);
    harness.appServer.notify("item/commandExecution/started", {
      threadId: task.codexThreadId,
      turnId: task.codexTurnId,
      item: { id: "command", type: "commandExecution", command: "pwd" },
    });
    await vi.advanceTimersByTimeAsync(800);
    expect(
      harness.appServer.clientMessages.some(
        (message) => message.method === "turn/interrupt",
      ),
    ).toBe(false);

    await vi.advanceTimersByTimeAsync(201);
    expect(
      harness.appServer.clientMessages.some(
        (message) => message.method === "turn/interrupt",
      ),
    ).toBe(true);
    expect(harness.manager.getTask(task.id)).toMatchObject({
      status: "running",
      cancellationRequested: true,
    });
    expect(
      harness.events.some(
        (event) =>
          event.type === "act.event" &&
          (event.payload as { taskId?: string; event?: string }).taskId === task.id &&
          (event.payload as { event?: string }).event === "inactivity_timeout",
      ),
    ).toBe(true);
  });

  it("clears the inactivity watchdog when Codex reports a terminal turn", async () => {
    vi.useFakeTimers();
    const harness = createHarness(undefined, 100);
    const task = await approveTask(harness);
    harness.appServer.notify("turn/completed", {
      threadId: task.codexThreadId,
      turn: {
        id: task.codexTurnId,
        status: "completed",
        error: null,
      },
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(harness.manager.getTask(task.id)).toMatchObject({
      status: "completed",
      completedAt: expect.any(String),
    });
    expect(
      harness.appServer.clientMessages.some(
        (message) => message.method === "turn/interrupt",
      ),
    ).toBe(false);
  });

  it("attributes resumed-thread events to the active turn rather than a historical task", async () => {
    const harness = createHarness();
    const first = await approveTask(harness);
    harness.appServer.notify("turn/completed", {
      threadId: first.codexThreadId,
      turn: {
        id: first.codexTurnId,
        status: "completed",
        error: null,
      },
    });

    const secondPending = harness.manager.createTask(
      "Continue in the existing Codex thread.",
    );
    const second = await harness.manager.approve(secondPending.id);
    expect(second).toMatchObject({
      codexThreadId: first.codexThreadId,
      codexTurnId: "turn-2",
      status: "running",
    });

    harness.appServer.notify("item/commandExecution/started", {
      threadId: second.codexThreadId,
      turnId: second.codexTurnId,
      item: { id: "command-two", type: "commandExecution", command: "pwd" },
    });
    harness.appServer.request("approval-two", "item/commandExecution/requestApproval", {
      threadId: second.codexThreadId,
      turnId: second.codexTurnId,
      itemId: "command-two",
      command: "pwd",
    });

    const taskEvents = harness.events
      .filter((event) => event.type === "act.event")
      .map((event) => event.payload as { taskId?: string; event?: string });
    expect(taskEvents).toContainEqual(
      expect.objectContaining({
        taskId: second.id,
        event: "item/commandExecution/started",
      }),
    );
    expect(taskEvents).toContainEqual(
      expect.objectContaining({
        taskId: second.id,
        event: "request_denied",
      }),
    );
    expect(
      taskEvents.filter(
        (event) =>
          event.taskId === first.id &&
          (event.event === "item/commandExecution/started" ||
            event.event === "request_denied"),
      ),
    ).toHaveLength(0);
  });

  it("falls back to a fresh thread when a persisted Codex thread is stale", async () => {
    const harness = createHarness("thread-stale");
    harness.appServer.resumeError = "thread not found";
    const task = harness.manager.createTask("Start from a safe fresh thread.");

    const approved = await harness.manager.approve(task.id);
    const methods = harness.appServer.clientMessages
      .filter((message) => message.method)
      .map((message) => message.method);

    expect(methods).toEqual([
      "initialize",
      "initialized",
      "thread/resume",
      "thread/start",
      "turn/start",
    ]);
    expect(approved).toMatchObject({
      status: "running",
      codexThreadId: "thread-1",
    });
  });

  it("distinguishes server requests from RPC responses and denies added approvals", async () => {
    const harness = createHarness();
    const task = await approveTask(harness);

    harness.appServer.request(700, "item/commandExecution/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      command: "curl https://example.com",
    });
    harness.appServer.request("permission-1", "item/permissions/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "permission-item",
      permissions: { network: true },
    });
    harness.appServer.request("unsupported-1", "item/tool/requestUserInput", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "question-1",
    });

    expect(harness.appServer.response(700)).toMatchObject({
      id: 700,
      result: { decision: "decline" },
    });
    expect(harness.appServer.response("permission-1")).toMatchObject({
      id: "permission-1",
      result: {
        permissions: {},
        scope: "turn",
        strictAutoReview: true,
      },
    });
    expect(harness.appServer.response("unsupported-1")).toMatchObject({
      id: "unsupported-1",
      error: { code: -32601 },
    });
    expect(harness.manager.getTask(task.id)?.status).toBe("running");
  });

  it("explicitly denies a request to grant writes outside the workspace", async () => {
    const harness = createHarness();
    const task = await approveTask(harness);

    harness.appServer.request("external-write", "item/fileChange/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "file-change-1",
      grantRoot: "/private/tmp/outside-workspace",
    });

    expect(harness.appServer.response("external-write")).toMatchObject({
      id: "external-write",
      result: { decision: "decline" },
    });
    expect(harness.manager.getTask(task.id)?.status).toBe("running");
    expect(
      harness.events.some(
        (event) =>
          event.type === "act.codex.request.denied" &&
          (event.payload as { method?: string }).method ===
            "item/fileChange/requestApproval",
      ),
    ).toBe(true);
  });

  it("keeps a cancellation pending until Codex reports an interrupted terminal turn", async () => {
    const harness = createHarness();
    const task = await approveTask(harness);

    const cancelling = await harness.manager.cancel(task.id);
    const interrupt = harness.appServer.clientMessages.find(
      (message) => message.method === "turn/interrupt",
    );

    expect(interrupt?.params).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(cancelling.status).toBe("running");
    expect(harness.manager.getTask(task.id)?.status).toBe("running");

    harness.appServer.notify("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "interrupted",
        error: null,
      },
    });

    expect(harness.manager.getTask(task.id)).toMatchObject({
      status: "cancelled",
      completedAt: expect.any(String),
    });
  });

  it("terminates an ambiguous turn/interrupt session before another task starts", async () => {
    const firstServer = new FakeCodexAppServer();
    const secondServer = new FakeCodexAppServer();
    const harness = createHarness(undefined, undefined, {
      appServers: [firstServer, secondServer],
      requestTimeoutMs: 20,
    });
    const first = await approveTask(harness);
    firstServer.holdInterrupt = true;

    await expect(harness.manager.cancel(first.id)).rejects.toThrow(
      "Codex request timed out: turn/interrupt",
    );
    expect(firstServer.killed).toBe(true);
    expect(harness.manager.getTask(first.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("outcome of turn/interrupt was ambiguous"),
    });

    const second = harness.manager.createTask("Start after the interrupted session exits.");
    await expect(harness.manager.approve(second.id)).resolves.toMatchObject({
      status: "running",
    });
    expect(
      firstServer.clientMessages.filter((message) => message.method === "turn/start"),
    ).toHaveLength(1);
    expect(
      secondServer.clientMessages.filter((message) => message.method === "turn/start"),
    ).toHaveLength(1);
  });

  it("keeps an explicitly rejected interrupt active and exclusive", async () => {
    const harness = createHarness();
    harness.appServer.interruptError = "interrupt rejected by app server";
    const task = await approveTask(harness);

    await expect(harness.manager.cancel(task.id)).rejects.toThrow(
      "interrupt rejected by app server",
    );
    expect(harness.manager.getTask(task.id)).toMatchObject({
      status: "running",
      error: expect.stringContaining("interrupt rejected by app server"),
    });
    expect(harness.manager.getTask(task.id)).not.toHaveProperty(
      "cancellationRequested",
    );
    expect(
      harness.events.some(
        (event) =>
          event.type === "act.event" &&
          (event.payload as { taskId?: string; event?: string }).taskId === task.id &&
          (event.payload as { event?: string }).event === "cancel_failed",
      ),
    ).toBe(true);
    const second = harness.manager.createTask("Do not overlap a still-running turn.");
    await expect(harness.manager.approve(second.id)).rejects.toThrow(
      "Another Codex task is already active",
    );
  });

  it("maps failed terminal turns to failed tasks with a visible error", async () => {
    const harness = createHarness();
    const task = await approveTask(harness);

    harness.appServer.notify("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "failed",
        error: { message: "sandbox rejected a write" },
      },
    });

    expect(harness.manager.getTask(task.id)).toMatchObject({
      status: "failed",
      completedAt: expect.any(String),
      error: "sandbox rejected a write",
    });
  });

  it("invalidates cached availability and fails active tasks when App Server exits", async () => {
    const harness = createHarness();
    const task = await approveTask(harness);

    expect(harness.versionChecks()).toBe(1);
    harness.appServer.crash();

    expect(harness.manager.getTask(task.id)).toMatchObject({
      status: "failed",
      completedAt: expect.any(String),
      error: expect.stringContaining("Codex exited"),
    });
    await expect(harness.manager.availability()).resolves.toEqual({
      available: true,
      version: TESTED_CODEX_VERSION,
    });
    expect(harness.versionChecks()).toBe(2);
  });
});
