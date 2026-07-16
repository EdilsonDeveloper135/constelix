import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ConstelixDatabase } from "./database.js";
import type { EventBus } from "./events.js";
import { createSafeChildEnvironment, redactSecrets } from "./security.js";

const execFileAsync = promisify(execFile);
export const TESTED_CODEX_VERSION = "0.144.1";
const APPROVAL_TTL_MS = 15 * 60 * 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

type CodexAppServerProcess = Pick<
  ChildProcessWithoutNullStreams,
  "stdin" | "stdout" | "stderr" | "killed" | "kill" | "once"
>;
type RpcId = number | string;

export interface CodexManagerOptions {
  getCodexVersion?: () => Promise<string | undefined>;
  spawnAppServer?: (
    workspaceRoot: string,
    environment: NodeJS.ProcessEnv,
  ) => CodexAppServerProcess;
  requestTimeoutMs?: number;
}

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
  completedAt?: string;
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
  #process: CodexAppServerProcess | undefined;
  #requestId = 0;
  #stdoutBuffer = "";
  #availability: { available: boolean; version?: string; reason?: string } | undefined;

  constructor(
    private readonly workspaceId: string,
    private readonly workspaceRoot: string,
    private readonly events: EventBus,
    private readonly database: ConstelixDatabase,
    private readonly options: CodexManagerOptions = {},
  ) {}

  async availability(): Promise<{ available: boolean; version?: string; reason?: string }> {
    if (this.#availability) return this.#availability;
    try {
      const version = this.options.getCodexVersion
        ? await this.options.getCodexVersion()
        : await resolveInstalledCodexVersion();
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
      if (!turnId) throw new Error("Codex did not return a turn id.");
      task.codexTurnId = turnId;
      task.status = "running";
      this.persist(task);
      this.events.publish("act.task.started", task);
      this.publishAct(task, "started");
      return task;
    } catch (error) {
      task.status = "failed";
      task.completedAt = new Date().toISOString();
      task.error = redactSecrets(
        error instanceof Error ? error.message : "Codex failed to start.",
      );
      this.persist(task);
      this.events.publish("act.task.failed", {
        taskId: task.id,
        message: task.error,
      });
      this.publishAct(task, "failed", {
        message: task.error,
      });
      throw error;
    }
  }

  async cancel(id: string): Promise<ActTaskRecord> {
    const task = this.requireTask(id);
    if (task.status === "pending_approval") {
      task.status = "cancelled";
      task.completedAt = new Date().toISOString();
      this.persist(task);
      this.events.publish("act.task.cancelled", { taskId: task.id });
      this.publishAct(task, "cancelled");
      return task;
    }

    if (task.status !== "running") {
      if (isTerminalTaskStatus(task.status)) return task;
      throw new Error("Only pending or running tasks can be cancelled.");
    }
    if (!task.codexThreadId || !task.codexTurnId) {
      const message = "Codex cannot cancel a turn without both thread and turn ids.";
      task.status = "failed";
      task.completedAt = new Date().toISOString();
      task.error = message;
      this.persist(task);
      this.events.publish("act.task.failed", { taskId: task.id, message });
      this.publishAct(task, "failed", { message });
      throw new Error(message);
    }

    try {
      await this.request("turn/interrupt", {
        threadId: task.codexThreadId,
        turnId: task.codexTurnId,
      });
    } catch (error) {
      const message = redactSecrets(
        error instanceof Error ? error.message : "Codex failed to request cancellation.",
      );
      task.status = "failed";
      task.completedAt = new Date().toISOString();
      task.error = message;
      this.persist(task);
      this.events.publish("act.task.failed", { taskId: task.id, message });
      this.publishAct(task, "failed", { message });
      throw error;
    }

    this.database.audit(this.workspaceId, "codex", "turn/interrupt", "requested", {
      taskId: task.id,
    });
    this.publishAct(task, "cancel_requested", {
      message: "Constelix solicitó cancelar el turno; espera la confirmación de Codex.",
    });
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
    const environment = createSafeChildEnvironment();
    const child = this.options.spawnAppServer
      ? this.options.spawnAppServer(this.workspaceRoot, environment)
      : spawn("codex", ["app-server"], {
          cwd: this.workspaceRoot,
          env: environment,
          stdio: ["pipe", "pipe", "pipe"],
        });
    this.#process = child;
    this.#stdoutBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => this.consumeStdout(data));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => {
      this.events.publish("act.runtime.notice", {
        message: redactSecrets(data).slice(0, 2_000),
      });
    });
    child.once("exit", (code, signal) => this.handleExit(child, code, signal));
    child.once("error", (error) => this.handleExit(child, null, null, error));

    await this.request("initialize", {
      clientInfo: { name: "constelix", title: "Constelix", version: "0.0.1" },
    });
    this.notify("initialized");
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.#requestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      timeout.unref();
      this.#pending.set(id, { resolve, reject, timeout });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error("Unable to contact Codex."));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { method } : { method, params });
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

    const method = typeof message.method === "string" ? message.method : undefined;
    if (method && isRpcId(message.id)) {
      this.handleServerRequest(
        message.id,
        method,
        asRecord(message.params),
      );
      return;
    }

    if (!method && typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pending.delete(message.id);
      if (message.error !== undefined && message.error !== null) {
        pending.reject(new Error(redactSecrets(JSON.stringify(message.error))));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (!method) return;
    const params = asRecord(message.params);
    this.events.publish("act.codex.event", { method, params });
    const eventThreadId = getEventThreadId(params);
    const eventTask = eventThreadId
      ? [...this.#tasks.values()].find((candidate) => candidate.codexThreadId === eventThreadId)
      : undefined;
    if (eventTask && (method.startsWith("item/") || method === "turn/started")) {
      const summary = summarizeCodexEvent(method, params);
      this.database.audit(this.workspaceId, "codex", method, "event", {
        taskId: eventTask.id,
        summary,
      });
      this.publishAct(eventTask, method, { message: summary });
    }

    if (method === "turn/completed") {
      const threadId = getEventThreadId(params);
      const turn = asRecord(params.turn);
      const turnId = typeof turn.id === "string" ? turn.id : undefined;
      const task = [...this.#tasks.values()].find(
        (candidate) =>
          candidate.codexThreadId === threadId &&
          candidate.status === "running" &&
          candidate.codexTurnId === turnId,
      );
      if (task) {
        const terminal = mapTerminalTurn(turn);
        task.status = terminal.status;
        task.completedAt = new Date().toISOString();
        if (terminal.error) {
          task.error = terminal.error;
        } else {
          delete task.error;
        }
        this.persist(task);
        if (task.status === "failed") {
          this.events.publish("act.task.failed", {
            taskId: task.id,
            message: task.error ?? "Codex reported a failed turn.",
          });
          this.publishAct(task, "failed", {
            message: task.error ?? "Codex reported a failed turn.",
          });
        } else if (task.status === "cancelled") {
          this.events.publish("act.task.cancelled", { taskId: task.id });
          this.publishAct(task, "cancelled");
        } else {
          this.events.publish("act.task.completed", task);
          this.publishAct(task, "completed");
        }
      }
    }
  }

  private handleServerRequest(
    id: RpcId,
    method: string,
    params: Record<string, unknown>,
  ): void {
    const task = this.findTaskForParams(params);
    const response = deniedServerRequestResponse(id, method);
    try {
      this.send(response);
    } catch (error) {
      this.events.publish("act.runtime.notice", {
        message: redactSecrets(
          error instanceof Error
            ? error.message
            : `Unable to deny Codex request ${method}.`,
        ),
      });
      return;
    }

    const summary = summarizeDeniedServerRequest(method, params);
    this.database.audit(this.workspaceId, "codex", method, "denied", {
      ...(task ? { taskId: task.id } : {}),
      summary,
    });
    this.events.publish("act.codex.request.denied", {
      ...(task ? { taskId: task.id } : {}),
      method,
      message: summary,
    });
    if (task) {
      this.publishAct(task, "request_denied", { message: summary });
    }
  }

  private findTaskForParams(params: Record<string, unknown>): ActTaskRecord | undefined {
    const threadId = getEventThreadId(params);
    return threadId
      ? [...this.#tasks.values()].find((candidate) => candidate.codexThreadId === threadId)
      : undefined;
  }

  private handleExit(
    child: CodexAppServerProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
    cause?: Error,
  ): void {
    if (this.#process !== child) return;
    this.#process = undefined;
    this.#availability = undefined;
    this.#stdoutBuffer = "";
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
        task.completedAt = new Date().toISOString();
        task.error = error.message;
        this.persist(task);
        this.events.publish("act.task.failed", {
          taskId: task.id,
          message: error.message,
        });
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
    const child = this.#process;
    if (!child) return;
    this.handleExit(
      child,
      null,
      "SIGTERM",
      new CodexUnavailableError("Codex manager closed."),
    );
    child.kill("SIGTERM");
  }
}

async function resolveInstalledCodexVersion(): Promise<string | undefined> {
  const { stdout } = await execFileAsync("codex", ["--version"], {
    env: createSafeChildEnvironment(),
    timeout: 5_000,
  });
  return /\b(\d+\.\d+\.\d+)\b/.exec(stdout)?.[1];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isRpcId(value: unknown): value is RpcId {
  return typeof value === "number" || typeof value === "string";
}

function getEventThreadId(params: Record<string, unknown>): string | undefined {
  if (typeof params.threadId === "string") return params.threadId;
  return typeof params.conversationId === "string" ? params.conversationId : undefined;
}

function deniedServerRequestResponse(
  id: RpcId,
  method: string,
): Record<string, unknown> {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { id, result: { decision: "decline" } };
    case "applyPatchApproval":
    case "execCommandApproval":
      return { id, result: { decision: "denied" } };
    case "item/permissions/requestApproval":
      return {
        id,
        result: {
          permissions: {},
          scope: "turn",
          strictAutoReview: true,
        },
      };
    default:
      return {
        id,
        error: {
          code: -32601,
          message: `Server request ${method} is not supported by Constelix.`,
        },
      };
  }
}

function summarizeDeniedServerRequest(
  method: string,
  params: Record<string, unknown>,
): string {
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    const grantRoot = typeof params.grantRoot === "string"
      ? ` (${redactSecrets(params.grantRoot).slice(0, 400)})`
      : "";
    return `Constelix denegó una solicitud adicional de escritura${grantRoot}; el turno no puede ampliar su alcance.`;
  }
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    return "Constelix denegó una solicitud adicional de ejecución; el turno no puede ampliar su alcance.";
  }
  if (method === "item/permissions/requestApproval") {
    return "Constelix denegó una ampliación de permisos solicitada por Codex.";
  }
  return `Constelix rechazó la solicitud server→client no soportada ${method}.`;
}

function mapTerminalTurn(
  turn: Record<string, unknown>,
): { status: "completed" | "failed" | "cancelled"; error?: string } {
  const status = typeof turn.status === "string" ? turn.status : "unknown";
  if (status === "completed") return { status: "completed" };
  if (status === "interrupted" || status === "cancelled") {
    return { status: "cancelled" };
  }
  if (status === "failed") {
    return {
      status: "failed",
      error: extractTurnError(turn.error) ?? "Codex reported a failed turn.",
    };
  }
  return {
    status: "failed",
    error: `Codex completed with an unexpected terminal status: ${redactSecrets(status)}.`,
  };
}

function extractTurnError(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return redactSecrets(value);
  const error = asRecord(value);
  if (typeof error.message === "string" && error.message.trim()) {
    return redactSecrets(error.message);
  }
  return undefined;
}

function isTerminalTaskStatus(status: ActTaskStatus): boolean {
  return status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "expired";
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
