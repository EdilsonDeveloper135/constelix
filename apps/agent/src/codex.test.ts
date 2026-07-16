import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import {
  CodexManager,
  TESTED_CODEX_VERSION,
  createCodexSandboxPolicy,
  type CodexManagerOptions,
} from "./codex.js";
import { EventBus, type LocalServerEvent } from "./events.js";
import type { ConstelixDatabase } from "./database.js";

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
  #stdinBuffer = "";

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
      case "turn/start":
        this.sendToClient({
          id: message.id,
          result: { turn: { id: "turn-1" } },
        });
        return;
      case "turn/interrupt":
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
});

function createHarness(): Harness {
  const workspaceId = "workspace-1";
  const workspaceRoot = "/workspace";
  const database = {
    saveCodexTask: () => undefined,
    audit: () => undefined,
  } as unknown as ConstelixDatabase;
  const eventBus = new EventBus();
  const publishedEvents: LocalServerEvent[] = [];
  const unsubscribe = eventBus.subscribe((event) => publishedEvents.push(event));
  const appServer = new FakeCodexAppServer();
  let checks = 0;
  const manager = new CodexManager(workspaceId, workspaceRoot, eventBus, database, {
    getCodexVersion: async () => {
      checks += 1;
      return TESTED_CODEX_VERSION;
    },
    spawnAppServer: () => appServer as unknown as SpawnedCodexProcess,
    requestTimeoutMs: 1_000,
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

  it("surfaces an interrupt failure instead of silently marking the task cancelled", async () => {
    const harness = createHarness();
    harness.appServer.interruptError = "interrupt rejected by app server";
    const task = await approveTask(harness);

    await expect(harness.manager.cancel(task.id)).rejects.toThrow(
      "interrupt rejected by app server",
    );
    expect(harness.manager.getTask(task.id)).toMatchObject({
      status: "failed",
      completedAt: expect.any(String),
      error: expect.stringContaining("interrupt rejected by app server"),
    });
    expect(
      harness.events.some(
        (event) =>
          event.type === "act.task.failed" &&
          (event.payload as { taskId?: string }).taskId === task.id,
      ),
    ).toBe(true);
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
