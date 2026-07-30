import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ConstelixDatabase } from "./database.js";
import type { EventBus } from "./events.js";
import {
  assertWorkspaceReferenceIdentity,
  createSafeChildEnvironment,
  redactSecrets,
  workspaceRootOf,
  type WorkspaceReference,
} from "./security.js";

const execFileAsync = promisify(execFile);
export const TESTED_CODEX_VERSION = "0.144.5";
const APPROVAL_TTL_MS = 15 * 60 * 1_000;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const SESSION_TERMINATION_GRACE_MS = 1_000;

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
  inactivityTimeoutMs?: number;
}

export interface CodexAvailability {
  available: boolean;
  version?: string;
  reason?: string;
}

export interface CodexAvailabilitySnapshot extends CodexAvailability {
  checking: boolean;
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
  cancellationRequested?: boolean;
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
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export class CodexUnavailableError extends Error {
  readonly code = "CODEX_UNAVAILABLE";
}

class CodexRpcError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(message);
    this.name = "CodexRpcError";
  }
}

class CodexRequestTimeoutError extends Error {
  constructor(readonly method: string) {
    super(`Codex request timed out: ${method}`);
    this.name = "CodexRequestTimeoutError";
  }
}

class CodexTransportError extends Error {
  readonly cause: Error;

  constructor(
    readonly method: string,
    cause: Error,
  ) {
    super(`Codex transport failed during ${method}: ${cause.message}`);
    this.name = "CodexTransportError";
    this.cause = cause;
  }
}

class CodexSessionQuarantinedError extends CodexUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "CodexSessionQuarantinedError";
  }
}

export class CodexManager {
  readonly #tasks = new Map<string, ActTaskRecord>();
  readonly #pending = new Map<number, PendingRequest>();
  readonly #forcedExitCauses = new WeakMap<object, Error>();
  #process: CodexAppServerProcess | undefined;
  #requestId = 0;
  #stdoutBuffer = "";
  #availability: CodexAvailability | undefined;
  #availabilityPromise: Promise<CodexAvailability> | undefined;
  #availabilityGeneration = 0;
  #resumeThreadId: string | undefined;
  #startPromise: Promise<void> | undefined;
  readonly #activityTimers = new Map<string, NodeJS.Timeout>();
  readonly #workspaceRoot: string;

  constructor(
    private readonly workspaceId: string,
    private readonly workspace: WorkspaceReference,
    private readonly events: EventBus,
    private readonly database: ConstelixDatabase,
    private readonly options: CodexManagerOptions = {},
  ) {
    this.#workspaceRoot = workspaceRootOf(workspace);
    this.#resumeThreadId = database.loadLatestCodexThreadId(workspaceId);
  }

  peekAvailability(): CodexAvailabilitySnapshot {
    if (this.#availability) {
      return { ...this.#availability, checking: false };
    }
    return {
      available: false,
      checking: true,
      reason: `Checking Codex CLI ${TESTED_CODEX_VERSION} compatibility.`,
    };
  }

  async availability(): Promise<CodexAvailability> {
    if (this.#availability) return this.#availability;
    if (this.#availabilityPromise) return this.#availabilityPromise;

    const generation = this.#availabilityGeneration;
    const check = this.resolveAvailability();
    this.#availabilityPromise = check;
    try {
      const availability = await check;
      if (generation === this.#availabilityGeneration) {
        this.#availability = availability;
        this.publishAvailability(availability);
      }
      return availability;
    } finally {
      if (this.#availabilityPromise === check) {
        this.#availabilityPromise = undefined;
      }
    }
  }

  createTask(
    objective: string,
    capabilities: readonly ["read", "write", "command"] | readonly ("read" | "write" | "command")[] = [
      "read",
      "write",
      "command",
    ],
  ): ActTaskRecord {
    const trimmed = objective.trim();
    if (!trimmed) throw new Error("A task objective is required.");
    if (trimmed.length > 20_000) throw new Error("Task objectives are limited to 20,000 characters.");
    const createdAt = new Date();
    const task: ActTaskRecord = {
      id: randomUUID(),
      objective: trimmed,
      status: "pending_approval",
      workspaceRoot: this.#workspaceRoot,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + APPROVAL_TTL_MS).toISOString(),
      scope: {
        protocolVersion: 1,
        workspaceId: this.workspaceId,
        rootPath: this.#workspaceRoot,
        objective: trimmed,
        capabilities: [...capabilities],
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

  get activeTask(): ActTaskRecord | undefined {
    const tasks = [...this.#tasks.values()];
    return (
      tasks.find(
        (task) =>
          task.status === "approved" ||
          task.status === "running",
      ) ??
      tasks.findLast((task) => task.status === "pending_approval")
    );
  }

  async approve(id: string): Promise<ActTaskRecord> {
    const task = this.requireTask(id);
    if (task.status !== "pending_approval") throw new Error("Only pending tasks can be approved.");
    if (Date.parse(task.expiresAt) <= Date.now()) {
      task.status = "expired";
      this.persist(task);
      throw new Error("The approval card expired. Create a new task.");
    }
    const activeTask = [...this.#tasks.values()].find(
      (candidate) =>
        candidate.id !== task.id &&
        (candidate.status === "approved" || candidate.status === "running"),
    );
    if (activeTask) {
      throw new Error("Another Codex task is already active in this workspace.");
    }
    await this.assertWorkspace();
    task.status = "approved";
    task.approvedAt = new Date().toISOString();
    this.persist(task);
    this.touchTask(task);
    try {
      const availability = await this.availability();
      if (task.cancellationRequested) {
        return this.completePreStartCancellation(task);
      }
      if (!availability.available) {
        throw new CodexUnavailableError(availability.reason);
      }
      await this.ensureStarted();
      if (task.cancellationRequested) {
        return this.completePreStartCancellation(task);
      }
      this.touchTask(task);
      const threadResult = await this.startOrResumeThread();
      const threadId = threadResult.thread?.id ?? threadResult.id;
      if (!threadId) throw new Error("Codex did not return a thread id.");
      this.#resumeThreadId = threadId;
      task.codexThreadId = threadId;
      if (task.cancellationRequested) {
        return this.completePreStartCancellation(task);
      }

      let turnId: string;
      try {
        await this.assertWorkspace();
        const turnResult = (await this.request("turn/start", {
          threadId,
          input: [{ type: "text", text: task.objective }],
          approvalPolicy: "never",
          sandboxPolicy: createCodexSandboxPolicy(this.#workspaceRoot),
        })) as { turn?: { id?: string }; id?: string };
        const receivedTurnId = turnResult.turn?.id ?? turnResult.id;
        if (!receivedTurnId) throw new Error("Codex did not return a turn id.");
        turnId = receivedTurnId;
      } catch (error) {
        if (!(error instanceof CodexRpcError)) {
          await this.invalidateAmbiguousSession("turn/start", error);
        }
        throw error;
      }
      task.codexTurnId = turnId;
      task.status = "running";
      this.persist(task);
      this.touchTask(task);
      this.events.publish("act.task.started", task);
      this.publishAct(task, "started");
      if (task.cancellationRequested) {
        await this.cancel(task.id);
      }
      return task;
    } catch (error) {
      if (task.status === "approved" && task.cancellationRequested) {
        return this.completePreStartCancellation(task);
      }
      if (error instanceof CodexSessionQuarantinedError) {
        task.error = redactSecrets(error.message);
        this.persist(task);
        this.publishAct(task, "session_quarantined", { message: task.error });
        throw error;
      }
      if (isTerminalTaskStatus(task.status)) throw error;
      this.clearTaskTimer(task.id);
      task.status = "failed";
      task.completedAt = new Date().toISOString();
      delete task.cancellationRequested;
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
      this.clearTaskTimer(task.id);
      task.status = "cancelled";
      task.completedAt = new Date().toISOString();
      delete task.cancellationRequested;
      this.persist(task);
      this.events.publish("act.task.cancelled", { taskId: task.id });
      this.publishAct(task, "cancelled");
      return task;
    }

    if (task.status === "approved") {
      this.clearTaskTimer(task.id);
      task.cancellationRequested = true;
      this.persist(task);
      this.publishAct(task, "cancel_requested", {
        message:
          "Constelix solicitó cancelar antes de iniciar el turno; espera la confirmación.",
      });
      return task;
    }

    if (task.status !== "running") {
      if (isTerminalTaskStatus(task.status)) return task;
      throw new Error("Only pending or running tasks can be cancelled.");
    }
    if (!task.codexThreadId || !task.codexTurnId) {
      const message = "Codex cannot cancel a turn without both thread and turn ids.";
      this.clearTaskTimer(task.id);
      task.status = "failed";
      task.completedAt = new Date().toISOString();
      delete task.cancellationRequested;
      task.error = message;
      this.persist(task);
      this.events.publish("act.task.failed", { taskId: task.id, message });
      this.publishAct(task, "failed", { message });
      throw new Error(message);
    }

    this.clearTaskTimer(task.id);
    task.cancellationRequested = true;
    this.persist(task);
    try {
      await this.request("turn/interrupt", {
        threadId: task.codexThreadId,
        turnId: task.codexTurnId,
      });
    } catch (error) {
      const message = redactSecrets(
        error instanceof Error ? error.message : "Codex failed to request cancellation.",
      );
      if (error instanceof CodexRpcError) {
        delete task.cancellationRequested;
        task.error = message;
        this.persist(task);
        this.touchTask(task);
        this.publishAct(task, "cancel_failed", { message });
        throw error;
      }
      try {
        await this.invalidateAmbiguousSession("turn/interrupt", error);
      } catch (terminationError) {
        if (terminationError instanceof CodexSessionQuarantinedError) {
          task.error = redactSecrets(terminationError.message);
          this.persist(task);
          this.publishAct(task, "session_quarantined", { message: task.error });
        }
        throw terminationError;
      }
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

  private completePreStartCancellation(task: ActTaskRecord): ActTaskRecord {
    this.clearTaskTimer(task.id);
    task.status = "cancelled";
    task.completedAt = new Date().toISOString();
    delete task.cancellationRequested;
    this.persist(task);
    this.events.publish("act.task.cancelled", { taskId: task.id });
    this.publishAct(task, "cancelled");
    return task;
  }

  private async resolveAvailability(): Promise<CodexAvailability> {
    try {
      const version = this.options.getCodexVersion
        ? await this.options.getCodexVersion()
        : await resolveInstalledCodexVersion();
      if (!version) {
        return {
          available: false,
          reason: "Unable to determine Codex CLI version.",
        };
      }
      if (version !== TESTED_CODEX_VERSION) {
        return {
          available: false,
          version,
          reason: `Constelix currently supports Codex CLI ${TESTED_CODEX_VERSION}.`,
        };
      }
      return { available: true, version };
    } catch {
      return {
        available: false,
        reason: `Codex CLI ${TESTED_CODEX_VERSION} was not found on PATH.`,
      };
    }
  }

  private publishAvailability(availability: CodexAvailability): void {
    this.events.publish("capabilities.updated", {
      act: availability.available,
      checking: false,
      ...(availability.version === undefined
        ? {}
        : { codexVersion: availability.version }),
      ...(availability.reason === undefined
        ? {}
        : { codexReason: availability.reason }),
    });
  }

  private touchTask(task: ActTaskRecord): void {
    if (
      (task.status !== "approved" && task.status !== "running") ||
      task.cancellationRequested
    ) {
      return;
    }
    this.clearTaskTimer(task.id);
    const timeout = setTimeout(() => {
      this.#activityTimers.delete(task.id);
      void this.cancelInactiveTask(task.id);
    }, this.options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS);
    timeout.unref();
    this.#activityTimers.set(task.id, timeout);
  }

  private clearTaskTimer(taskId: string): void {
    const timer = this.#activityTimers.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    this.#activityTimers.delete(taskId);
  }

  private async cancelInactiveTask(taskId: string): Promise<void> {
    const task = this.#tasks.get(taskId);
    if (
      !task ||
      (task.status !== "approved" && task.status !== "running") ||
      task.cancellationRequested
    ) {
      return;
    }
    this.database.audit(
      this.workspaceId,
      "codex",
      "turn/inactivity",
      "expired",
      {
        taskId: task.id,
        inactivityTimeoutMs:
          this.options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS,
      },
    );
    this.publishAct(task, "inactivity_timeout", {
      message:
        "Constelix canceló el turno porque no recibió actividad de Codex durante 15 minutos.",
    });
    try {
      await this.cancel(task.id);
    } catch {
      // cancel() persists and publishes the terminal failure.
    }
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

  private async startOrResumeThread(): Promise<{
    thread?: { id?: string };
    id?: string;
  }> {
    await this.assertWorkspace();
    const existingThreadId = this.#resumeThreadId;
    if (existingThreadId) {
      try {
        const resumed = (await this.request("thread/resume", {
          threadId: existingThreadId,
          cwd: this.#workspaceRoot,
          approvalPolicy: "never",
          sandbox: "workspace-write",
          excludeTurns: true,
        })) as { thread?: { id?: string }; id?: string };
        this.database.audit(this.workspaceId, "codex", "thread/resume", "success", {
          threadId: existingThreadId,
        });
        return resumed;
      } catch (error) {
        this.database.audit(this.workspaceId, "codex", "thread/resume", "failed", {
          threadId: existingThreadId,
          message: redactSecrets(
            error instanceof Error ? error.message : "Codex could not resume the thread.",
          ),
        });
        this.#resumeThreadId = undefined;
      }
    }

    return (await this.request("thread/start", {
      cwd: this.#workspaceRoot,
      approvalPolicy: "never",
      sandbox: "workspace-write",
    })) as { thread?: { id?: string }; id?: string };
  }

  private async ensureStarted(): Promise<void> {
    await this.assertWorkspace();
    if (this.#startPromise) return this.#startPromise;
    if (this.#process && !this.#process.killed) return;
    const environment = createSafeChildEnvironment();
    const child = this.options.spawnAppServer
      ? this.options.spawnAppServer(this.#workspaceRoot, environment)
      : spawn("codex", ["app-server"], {
          cwd: this.#workspaceRoot,
          env: environment,
          stdio: ["pipe", "pipe", "pipe"],
        });
    const start = (async () => {
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

      try {
        await this.request("initialize", {
          clientInfo: { name: "constelix", title: "Constelix", version: "0.0.5" },
        });
        this.notify("initialized");
      } catch (error) {
        if (this.#process === child) {
          this.handleExit(
            child,
            null,
            "SIGTERM",
            error instanceof Error ? error : new Error("Codex initialization failed."),
          );
          child.kill("SIGTERM");
        }
        throw error;
      }
    })();
    this.#startPromise = start;
    try {
      await start;
    } finally {
      if (this.#startPromise === start) this.#startPromise = undefined;
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.#requestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CodexRequestTimeoutError(method));
      }, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      timeout.unref();
      this.#pending.set(id, { method, resolve, reject, timeout });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        const cause =
          error instanceof Error ? error : new Error("Unable to contact Codex.");
        reject(new CodexTransportError(method, cause));
      }
    });
  }

  private async assertWorkspace(): Promise<void> {
    await assertWorkspaceReferenceIdentity(this.workspace);
  }

  private async invalidateAmbiguousSession(
    method: "turn/start" | "turn/interrupt",
    error: unknown,
  ): Promise<void> {
    const child = this.#process;
    if (!child) return;
    const message = redactSecrets(
      error instanceof Error ? error.message : `Codex ${method} failed without a response.`,
    );
    const cause = new CodexUnavailableError(
      `Codex session terminated because the outcome of ${method} was ambiguous: ${message}`,
    );
    this.#forcedExitCauses.set(child as object, cause);
    const exited = waitForProcessExit(child);

    let signalSent = child.killed;
    if (!signalSent) {
      try {
        signalSent = child.kill("SIGTERM");
      } catch {
        signalSent = false;
      }
    }
    if (!signalSent && this.#process === child) {
      try {
        signalSent = child.kill("SIGKILL");
      } catch {
        signalSent = false;
      }
    }

    if (signalSent && await waitForExitWithin(exited, SESSION_TERMINATION_GRACE_MS)) {
      return;
    }
    if (this.#process !== child) return;

    try {
      child.kill("SIGKILL");
    } catch {
      // The task remains active and blocks further approvals if termination fails.
    }
    if (await waitForExitWithin(exited, SESSION_TERMINATION_GRACE_MS)) return;
    if (this.#process !== child) return;

    throw new CodexSessionQuarantinedError(
      `Codex did not terminate after an ambiguous ${method} result. The task remains locked to prevent another turn from starting.`,
    );
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
        pending.reject(
          new CodexRpcError(
            pending.method,
            redactSecrets(JSON.stringify(message.error)),
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (!method) return;
    const params = asRecord(message.params);
    this.events.publish("act.codex.event", { method, params });
    const eventTask = this.findTaskForParams(params);
    if (eventTask) this.touchTask(eventTask);
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
        this.clearTaskTimer(task.id);
        const terminal = mapTerminalTurn(turn);
        task.status = terminal.status;
        task.completedAt = new Date().toISOString();
        delete task.cancellationRequested;
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
    if (task) this.touchTask(task);
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
    if (!threadId) return undefined;
    const candidates = [...this.#tasks.values()].filter(
      (candidate) => candidate.codexThreadId === threadId,
    );
    const turnId = getEventTurnId(params);
    if (turnId) {
      const exact = candidates.find(
        (candidate) => candidate.codexTurnId === turnId,
      );
      if (exact) return exact;
    }
    return candidates.findLast(
      (candidate) =>
        candidate.status === "approved" || candidate.status === "running",
    );
  }

  private handleExit(
    child: CodexAppServerProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
    cause?: Error,
  ): void {
    if (this.#process !== child) return;
    this.#process = undefined;
    this.#startPromise = undefined;
    this.#availability = undefined;
    this.#availabilityPromise = undefined;
    this.#availabilityGeneration += 1;
    this.#stdoutBuffer = "";
    const forcedCause = this.#forcedExitCauses.get(child as object);
    this.#forcedExitCauses.delete(child as object);
    const error = new CodexUnavailableError(
      redactSecrets(
        cause?.message ??
          forcedCause?.message ??
          `Codex exited (${code ?? "unknown"}/${signal ?? "no signal"}).`,
      ),
    );
    this.events.publish("capabilities.updated", {
      act: false,
      checking: false,
      codexReason: error.message,
    });
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const task of this.#tasks.values()) {
      if (task.status === "running" || task.status === "approved") {
        this.clearTaskTimer(task.id);
        task.status = "failed";
        task.completedAt = new Date().toISOString();
        delete task.cancellationRequested;
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
    for (const taskId of this.#activityTimers.keys()) {
      this.clearTaskTimer(taskId);
    }
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

function getEventTurnId(params: Record<string, unknown>): string | undefined {
  if (typeof params.turnId === "string") return params.turnId;
  const turn = asRecord(params.turn);
  if (typeof turn.id === "string") return turn.id;
  const item = asRecord(params.item);
  return typeof item.turnId === "string" ? item.turnId : undefined;
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

function waitForProcessExit(child: CodexAppServerProcess): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("exit", finish);
    child.once("error", finish);
  });
}

async function waitForExitWithin(
  exited: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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
