import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ConstelixDatabase } from "./database.js";
import type { EventBus } from "./events.js";
import { createSafeChildEnvironment, redactSecrets } from "./security.js";

const execFileAsync = promisify(execFile);
const TESTED_CODEX_VERSION = "0.144.1";
const APPROVAL_TTL_MS = 15 * 60 * 1_000;

export function createCodexSandboxPolicy(workspaceRoot: string) {
  return {
    type: "workspaceWrite" as const,
    writableRoots: [workspaceRoot],
    networkAccess: true,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };
}

export type ActTaskStatus =
  | "pending_approval"
  | "approved"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export interface ActTaskRecord {
  id: string;
  objective: string;
  status: ActTaskStatus;
  workspaceRoot: string;
  createdAt: string;
  expiresAt: string;
  scope: {
    protocolVersion: 1;
    workspaceId: string;
    rootPath: string;
    objective: string;
    capabilities: Array<"read" | "write" | "command">;
    networkEnabled: true;
    outsideWorkspaceWrites: false;
    expiresAt: string;
  };
  approvedAt?: string;
  codexThreadId?: string;
  codexTurnId?: string;
  error?: string;
  warning: string;
  capabilities: {
    workspaceWrite: true;
    commands: true;
    network: true;
    outsideWorkspaceWrite: false;
  };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export class CodexUnavailableError extends Error {
  readonly code = "CODEX_UNAVAILABLE";
}

export class CodexManager {
  readonly #tasks = new Map<string, ActTaskRecord>();
  readonly #pending = new Map<number, PendingRequest>();
  #process: ChildProcessWithoutNullStreams | undefined;
  #requestId = 0;
  #stdoutBuffer = "";
  #availability: { available: boolean; version?: string; reason?: string } | undefined;

  constructor(
    private readonly workspaceId: string,
    private readonly workspaceRoot: string,
    private readonly events: EventBus,
    private readonly database: ConstelixDatabase,
  ) {}

  async availability(): Promise<{ available: boolean; version?: string; reason?: string }> {
    if (this.#availability) return this.#availability;
    try {
      const { stdout } = await execFileAsync("codex", ["--version"], {
        env: createSafeChildEnvironment(),
        timeout: 5_000,
      });
      const version = /\b(\d+\.\d+\.\d+)\b/.exec(stdout)?.[1];
      if (!version) {
        this.#availability = { available: false, reason: "Unable to determine Codex CLI version." };
      } else if (version !== TESTED_CODEX_VERSION) {
        this.#availability = {
          available: false,
          version,
          reason: `Constelix currently supports Codex CLI ${TESTED_CODEX_VERSION}.`,
        };
      } else {
        this.#availability = { available: true, version };
      }
    } catch {
      this.#availability = {
        available: false,
        reason: `Codex CLI ${TESTED_CODEX_VERSION} was not found on PATH.`,
      };
    }
    return this.#availability;
  }

  createTask(objective: string): ActTaskRecord {
    const trimmed = objective.trim();
    if (!trimmed) throw new Error("A task objective is required.");
    if (trimmed.length > 10_000) throw new Error("Task objectives are limited to 10,000 characters.");
    const createdAt = new Date();
    const task: ActTaskRecord = {
      id: randomUUID(),
      objective: trimmed,
      status: "pending_approval",
      workspaceRoot: this.workspaceRoot,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + APPROVAL_TTL_MS).toISOString(),
      scope: {
        protocolVersion: 1,
        workspaceId: this.workspaceId,
        rootPath: this.workspaceRoot,
        objective: trimmed,
        capabilities: ["read", "write", "command"],
        networkEnabled: true,
        outsideWorkspaceWrites: false,
        expiresAt: new Date(createdAt.getTime() + APPROVAL_TTL_MS).toISOString(),
      },
      warning:
        "This approved turn can edit the workspace, run commands, and use the network. Only approve trusted repositories. Writes outside the workspace remain blocked.",
      capabilities: {
        workspaceWrite: true,
        commands: true,
        network: true,
        outsideWorkspaceWrite: false,
      },
    };
    this.#tasks.set(task.id, task);
    this.persist(task);
    this.events.publish("act.task.created", task);
    this.publishAct(task, "created");
    return task;
  }

  getTask(id: string): ActTaskRecord | undefined {
    return this.#tasks.get(id);
  }

  async approve(id: string): Promise<ActTaskRecord> {
    const task = this.requireTask(id);
    if (task.status !== "pending_approval") throw new Error("Only pending tasks can be approved.");
    if (Date.parse(task.expiresAt) <= Date.now()) {
      task.status = "expired";
      this.persist(task);
      throw new Error("The approval card expired. Create a new task.");
    }
    const availability = await this.availability();
    if (!availability.available) throw new CodexUnavailableError(availability.reason);

    task.status = "approved";
    task.approvedAt = new Date().toISOString();
    this.persist(task);
    try {
      await this.ensureStarted();
      const threadResult = (await this.request("thread/start", {
        cwd: this.workspaceRoot,
        approvalPolicy: "never",
        sandbox: "workspace-write",
      })) as { thread?: { id?: string }; id?: string };
      const threadId = threadResult.thread?.id ?? threadResult.id;
      if (!threadId) throw new Error("Codex did not return a thread id.");
      task.codexThreadId = threadId;

      const turnResult = (await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: task.objective }],
        approvalPolicy: "never",
        sandboxPolicy: createCodexSandboxPolicy(this.workspaceRoot),
      })) as { turn?: { id?: string }; id?: string };
      const turnId = turnResult.turn?.id ?? turnResult.id;
      if (turnId) task.codexTurnId = turnId;
      task.status = "running";
      this.persist(task);
      this.events.publish("act.task.started", task);
      this.publishAct(task, "started");
      return task;
    } catch (error) {
      task.status = "failed";
      this.persist(task);
      this.events.publish("act.task.failed", {
        taskId: task.id,
        message: redactSecrets(error instanceof Error ? error.message : "Codex failed to start."),
      });
      this.publishAct(task, "failed", {
        message: redactSecrets(error instanceof Error ? error.message : "Codex failed to start."),
      });
      throw error;
    }
  }

  async cancel(id: string): Promise<ActTaskRecord> {
    const task = this.requireTask(id);
    if (task.status === "running" && task.codexThreadId) {
      await this.request("turn/interrupt", {
        threadId: task.codexThreadId,
        ...(task.codexTurnId ? { turnId: task.codexTurnId } : {}),
      }).catch(() => undefined);
    }
    task.status = "cancelled";
    this.persist(task);
    this.events.publish("act.task.cancelled", { taskId: task.id });
    this.publishAct(task, "cancelled");
    return task;
  }

  private requireTask(id: string): ActTaskRecord {
    const task = this.#tasks.get(id);
    if (!task) throw new Error("Act task not found.");
    return task;
  }

  private persist(task: ActTaskRecord): void {
    this.database.saveCodexTask(this.workspaceId, { ...task });
    this.database.audit(this.workspaceId, "codex", "task", task.status, {
      taskId: task.id,
      network: true,
      workspaceWrite: true,
      outsideWorkspaceWrite: false,
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.#process && !this.#process.killed) return;
    const child = spawn("codex", ["app-server"], {
        cwd: this.workspaceRoot,
        env: createSafeChildEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
    });
    this.#process = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => this.consumeStdout(data));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => {
      this.events.publish("act.runtime.notice", {
        message: redactSecrets(data).slice(0, 2_000),
      });
    });
    child.once("exit", (code, signal) => this.handleExit(code, signal));
    child.once("error", (error) => this.handleExit(null, null, error));

    await this.request("initialize", {
      clientInfo: { name: "constelix", title: "Constelix", version: "0.0.0" },
    });
    this.notify("initialized", {});
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.#requestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, 30_000);
      timeout.unref();
      this.#pending.set(id, { resolve, reject, timeout });
      this.send({ id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  private send(message: unknown): void {
    if (!this.#process?.stdin.writable) throw new CodexUnavailableError("Codex is not running.");
    this.#process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consumeStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    let newline = this.#stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#stdoutBuffer.slice(0, newline).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (line) this.consumeMessage(line);
      newline = this.#stdoutBuffer.indexOf("\n");
    }
  }

  private consumeMessage(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(redactSecrets(JSON.stringify(message.error))));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    const params = (message.params ?? {}) as Record<string, unknown>;
    this.events.publish("act.codex.event", { method: message.method, params });
    const eventThreadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const eventTask = eventThreadId
      ? [...this.#tasks.values()].find((candidate) => candidate.codexThreadId === eventThreadId)
      : undefined;
    if (eventTask && (message.method.startsWith("item/") || message.method === "turn/started")) {
      const summary = summarizeCodexEvent(message.method, params);
      this.database.audit(this.workspaceId, "codex", message.method, "event", {
        taskId: eventTask.id,
        summary,
      });
      this.publishAct(eventTask, message.method, { message: summary });
    }

    if (message.method === "turn/completed") {
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      const task = [...this.#tasks.values()].find(
        (candidate) => candidate.codexThreadId === threadId && candidate.status === "running",
      );
      if (task) {
        const turn = params.turn as { status?: string; error?: { message?: string } | null } | undefined;
        task.status = turn?.status === "failed" ? "failed" : "completed";
        if (task.status === "failed") {
          task.error = redactSecrets(turn?.error?.message ?? "Codex reported a failed turn.");
        }
        this.persist(task);
        this.events.publish(task.status === "failed" ? "act.task.failed" : "act.task.completed", task);
        this.publishAct(task, task.status === "failed" ? "failed" : "completed", task.error ? { message: task.error } : undefined);
      }
    }
  }

  private handleExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    cause?: Error,
  ): void {
    this.#process = undefined;
    const error = new CodexUnavailableError(
      redactSecrets(cause?.message ?? `Codex exited (${code ?? "unknown"}/${signal ?? "no signal"}).`),
    );
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const task of this.#tasks.values()) {
      if (task.status === "running" || task.status === "approved") {
        task.status = "failed";
        task.error = error.message;
        this.persist(task);
        this.publishAct(task, "failed", { message: error.message });
      }
    }
    this.events.publish("act.runtime.unavailable", { message: error.message });
  }

  private publishAct(
    task: ActTaskRecord,
    event: string,
    data?: Record<string, unknown>,
  ): void {
    const message =
      typeof data?.message === "string"
        ? data.message
        : event === "created"
          ? "Tarea preparada; espera la aprobación del usuario."
          : event === "started"
            ? "Codex inició el turno aprobado."
            : event === "completed"
              ? "Codex completó el turno."
              : event === "cancelled"
                ? "El turno de Codex fue cancelado."
                : `Evento de Codex: ${event}`;
    this.events.publish("act.event", {
      taskId: task.id,
      event,
      message,
      status:
        task.status === "pending_approval"
          ? "awaitingApproval"
          : task.status === "approved"
            ? "running"
            : task.status,
      ...(data === undefined ? {} : { data }),
    });
  }

  close(): void {
    this.#process?.kill("SIGTERM");
    this.#process = undefined;
  }
}

function summarizeCodexEvent(method: string, params: Record<string, unknown>): string {
  if (method === "turn/started") return "Codex inició la ejecución del turno.";
  const item = params.item as Record<string, unknown> | undefined;
  const type = typeof item?.type === "string" ? item.type : "item";
  const command = typeof item?.command === "string"
    ? item.command
    : Array.isArray(item?.command)
      ? item.command.filter((part): part is string => typeof part === "string").join(" ")
      : undefined;
  const detail = command ? `: ${command.slice(0, 400)}` : "";
  return redactSecrets(`${method} · ${type}${detail}`);
}
