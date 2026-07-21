import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { ZodError } from "zod";
import {
  ActApproveRequestSchema,
  ActTaskRequestSchema,
  AskTurnRequestSchema,
  FileReadRequestSchema,
  FileWriteRequestSchema,
  GraphQuerySchema,
  LayoutWriteRequestSchema,
  LlmConfigurationUpdateSchema,
  PROTOCOL_VERSION,
  ProtocolOnlyRequestSchema,
  TerminalCreateRequestSchema,
  type ActTask,
} from "@constelix/contracts";
import {
  AskService,
  OpenAIUnavailableError,
  type AskServiceOptions,
} from "./ask.js";
import {
  CodexManager,
  CodexUnavailableError,
  type CodexManagerOptions,
} from "./codex.js";
import { ConstelixDatabase } from "./database.js";
import { EventBus } from "./events.js";
import {
  FileConflictError,
  FileTooLargeError,
  readWorkspaceTextFile,
  writeWorkspaceTextFile,
} from "./files.js";
import { WorkspaceIndexer } from "./indexer.js";
import {
  LlmConfigurationError,
  LlmConfigurationStore,
} from "./llm-config.js";
import {
  detectSupportedLanguage,
  type ScanWorkspaceOptions,
} from "./scanner.js";
import {
  PathSecurityError,
  WorkspaceIdentityError,
  WorkspaceReadOnlyError,
  WorkspaceValidationError,
  assertWorkspaceIdentity,
  createWorkspaceId as createCanonicalWorkspaceId,
  inspectWorkspace,
  redactLocalPaths,
  redactSecrets,
  summarizeWorkspacePath,
  type WorkspaceDescriptor,
} from "./security.js";
import {
  ReadOnlyTerminalUnavailableError,
  TerminalManager,
} from "./terminals.js";

export interface AgentServerOptions {
  workspaceRoot: string;
  readOnly?: boolean;
  dev?: boolean;
  port?: number;
  capabilityToken?: string;
  /**
   * Overrides the per-workspace state directory for isolated tests and
   * benchmarks. Production callers should use the macOS default.
   */
  storageDirectory?: string;
  databasePath?: string;
  webDistPath?: string;
  devOrigin?: string;
  askOptions?: AskServiceOptions;
  codexOptions?: CodexManagerOptions;
  /** Internal override for deterministic tests and the 10,000-file benchmark. */
  indexerScanOptions?: Omit<ScanWorkspaceOptions, "onProgress">;
}

export interface RunningAgentServer {
  app: FastifyInstance;
  workspaceId: string;
  capabilityToken: string;
  port: number;
  origin: string;
  close(): Promise<void>;
}

export async function startAgentServer(options: AgentServerOptions): Promise<RunningAgentServer> {
  const workspace = await inspectWorkspace(options.workspaceRoot, {
    forceReadOnly: options.readOnly,
  });
  const workspaceRoot = workspace.canonicalRoot;
  const workspaceId = workspace.workspaceId;
  const capabilityToken = options.capabilityToken ?? randomBytes(32).toString("base64url");
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
  assertStatePathOutsideWorkspace(workspaceRoot, storageDirectory, "storageDirectory");
  if (options.databasePath && options.databasePath !== ":memory:") {
    assertStatePathOutsideWorkspace(workspaceRoot, options.databasePath, "databasePath");
  }
  await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
  await chmod(storageDirectory, 0o700);
  const lock = await WorkspaceLock.acquire(
    resolve(storageDirectory, "agent.lock"),
    workspaceId,
  );
  let database: ConstelixDatabase | undefined;
  let events: EventBus | undefined;
  let indexer: WorkspaceIndexer | undefined;
  let terminals: TerminalManager | undefined;
  let ask: AskService | undefined;
  let llmConfigurationStore: LlmConfigurationStore | undefined;
  let codex: CodexManager | undefined;
  let app: FastifyInstance | undefined;
  let identityMonitor: NodeJS.Timeout | undefined;
  try {
    database = new ConstelixDatabase(
      options.databasePath ?? resolve(storageDirectory, "constelix.sqlite"),
    );
    database.upsertWorkspace(workspaceId, workspaceRoot);
    events = new EventBus((payload) => sanitizePublicPayload(payload, workspaceRoot));
    indexer = new WorkspaceIndexer(workspaceId, workspace, database, events, {
      assertWorkspace: () => assertWorkspaceIdentity(workspace),
      ...(options.indexerScanOptions === undefined
        ? {}
        : { scanOptions: options.indexerScanOptions }),
    });
    terminals = new TerminalManager(workspace, events);
    llmConfigurationStore = new LlmConfigurationStore(storageDirectory);
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
      void codex.availability();
    }
    app = Fastify({
      logger: false,
      bodyLimit: 2 * 1024 * 1024 + 64 * 1024,
    });
  } catch (error) {
    await cleanupAgentResources({
      app,
      ask,
      codex,
      terminals,
      indexer,
      events,
      database,
      lock,
    }).catch(() => undefined);
    throw error;
  }

  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    if (identityMonitor) {
      clearInterval(identityMonitor);
      identityMonitor = undefined;
    }
    cleanupPromise = cleanupAgentResources({
      app,
      ask,
      codex,
      terminals,
      indexer,
      events,
      database,
      lock,
    });
    return cleanupPromise;
  };

  try {
    await app.register(fastifyWebsocket, {
      options: { maxPayload: 512 * 1024, perMessageDeflate: false },
    });

  let boundOrigin: string | undefined;
  const allowedOrigins = new Set<string>();
  if (options.dev) {
    allowedOrigins.add(options.devOrigin ?? "http://127.0.0.1:5173");
    allowedOrigins.add("http://localhost:5173");
  }

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    const pathname = requestPathname(request.url);
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin) && origin !== boundOrigin) {
      return reply.code(403).send(errorBody("INVALID_ORIGIN", "Request origin is not allowed."));
    }
    if (boundOrigin && request.headers.host !== new URL(boundOrigin).host) {
      return reply.code(403).send(errorBody("INVALID_HOST", "Request host is not allowed."));
    }
    if (request.method === "OPTIONS") {
      if (origin && allowedOrigins.has(origin)) addCors(reply, origin);
      return reply.code(204).send();
    }
    if (pathname === "/api/v1/events") {
      if (!origin || (!allowedOrigins.has(origin) && origin !== boundOrigin)) {
        return reply.code(403).send(errorBody("INVALID_ORIGIN", "A valid WebSocket origin is required."));
      }
      if (!hasWebSocketCapability(request.url, capabilityToken)) {
        return reply.code(401).send(errorBody("UNAUTHORIZED", "A valid WebSocket capability token is required."));
      }
      await assertWorkspaceIdentity(workspace);
      return;
    }
    if (!hasCapability(request, capabilityToken)) {
      return reply.code(401).send(errorBody("UNAUTHORIZED", "A valid capability token is required."));
    }
    await assertWorkspaceIdentity(workspace);
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const origin = request.headers.origin;
    if (origin && allowedOrigins.has(origin)) addCors(reply, origin);
    reply.header("Cache-Control", request.url.startsWith("/api/") ? "no-store" : "no-cache");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    return payload;
  });

  app.get("/api/v1/events", { websocket: true }, (socket) => {
    events.attachAuthenticated(socket as never);
    void assertWorkspaceIdentity(workspace).catch(() => {
      socket.close(4409, "Workspace root changed");
    });
  });

  app.get("/api/v1/health", async () => ({
    protocolVersion: PROTOCOL_VERSION,
    status: "ok",
    workspaceId,
    index: indexer.status,
  }));

  app.get("/api/v1/bootstrap", async () => {
    const graph = indexer.graph.snapshot(500);
    const savedLayout = database.loadLayout(workspaceId) ?? { revision: 0, panels: [] };
    const codexAvailability = codex?.peekAvailability() ?? {
      available: false,
      checking: false,
      reason: "Actuar está deshabilitado en Modo Lectura.",
    };
    const activeActTask = codex?.activeTask ?? null;
    const total = indexer.status.total;
    return {
      protocolVersion: PROTOCOL_VERSION,
      workspace: {
        id: workspaceId,
        name: basename(workspaceRoot),
        rootPath: summarizeWorkspacePath(workspaceRoot),
        mode: workspace.mode,
        readOnly: workspace.readOnly,
      },
      summary: indexer.status.summary,
      graph,
      layout: savedLayout.panels,
      layoutState: savedLayout,
      conversation: database.loadAiMessages(`${workspaceId}:main`, workspaceId),
      activeAskTurnIds: ask.activeTurnIds,
      activeActTask: activeActTask
        ? toPublicActTask(activeActTask, workspaceRoot)
        : null,
      index: {
        ...indexer.status,
        progress: total === 0 ? 0 : indexer.status.completed / total,
        filesIndexed: indexer.indexedFileCount,
        symbolsIndexed: indexer.graph.nodeCount,
        edgesIndexed: indexer.graph.edgeCount,
      },
      terminals: terminals.list(),
      capabilities: {
        ask: true,
        askMode: ask.mode,
        askProviderStatus: ask.providerStatus,
        askNotice: ask.notice,
        llm: ask.llmConfiguration,
        act: !workspace.readOnly && codexAvailability.available,
        terminal: true,
        codexReason: codexAvailability.reason,
        codexChecking: codexAvailability.checking,
        codexVersion: codexAvailability.version,
        model: ask.model,
        languages: ["javascript", "typescript", "python"],
      },
    };
  });

  app.get("/api/v1/settings/llm", async () => ask.llmConfiguration);

  app.put("/api/v1/settings/llm", async (request) => {
    const input = LlmConfigurationUpdateSchema.parse(request.body);
    if (!llmConfigurationStore) {
      throw new LlmConfigurationError("El almacenamiento de configuración LLM no está disponible.");
    }
    const configuration = await llmConfigurationStore.update(input);
    const publicConfiguration = ask.reconfigure(configuration);
    database.audit(workspaceId, "settings", "llm.update", "success", {
      baseUrl: publicConfiguration.baseUrl,
      model: publicConfiguration.model,
      providerKind: publicConfiguration.providerKind,
      apiKeyAction: input.apiKey.action,
      apiKeyConfigured: publicConfiguration.apiKeyConfigured,
    });
    return publicConfiguration;
  });

  app.post("/api/v1/graph/query", async (request) => {
    const query = GraphQuerySchema.parse(request.body);
    return indexer.query(query);
  });

  app.post("/api/v1/files/read", async (request) => {
    const input = FileReadRequestSchema.parse(request.body);
    const file = await readWorkspaceTextFile(workspace, input.relativePath);
    return {
      protocolVersion: PROTOCOL_VERSION,
      relativePath: input.relativePath,
      content: file.content,
      contentHash: file.contentHash,
      language: detectSupportedLanguage(input.relativePath) ?? "unknown",
      size: file.sizeBytes,
      modifiedAt: new Date(file.mtimeMs).toISOString(),
    };
  });

  app.put("/api/v1/files/write", async (request) => {
    const input = FileWriteRequestSchema.parse(request.body);
    const file = await writeWorkspaceTextFile(workspace, {
      relativePath: input.relativePath,
      content: input.content,
      expectedContentHash: input.expectedContentHash,
    });
    database.audit(workspaceId, "file", "write", "success", {
      relativePath: input.relativePath,
      sizeBytes: file.sizeBytes,
    });
    indexer.notifyPathChanged(input.relativePath, 25);
    return {
      protocolVersion: PROTOCOL_VERSION,
      relativePath: input.relativePath,
      contentHash: file.contentHash,
      modifiedAt: new Date(file.mtimeMs).toISOString(),
      graphRevision: indexer.graph.revision,
    };
  });

  app.put("/api/v1/layout", async (request) => {
    const input = LayoutWriteRequestSchema.parse(request.body);
    const revision = input.revision ?? indexer.graph.revision;
    const saved = database.saveLayout(workspaceId, revision, input.panels);
    return { protocolVersion: PROTOCOL_VERSION, saved, revision };
  });

  app.post("/api/v1/terminals", async (request, reply) => {
    const input = TerminalCreateRequestSchema.parse(request.body);
    const terminal = await terminals.create({
      cwd: input.cwd,
      cols: input.columns,
      rows: input.rows,
      ...(input.shell === undefined ? {} : { shell: input.shell }),
      ...(input.panelId === undefined ? {} : { panelId: input.panelId }),
    });
    database.audit(workspaceId, "terminal", "create", "success", { cwd: input.cwd ?? "." });
    return reply.code(201).send({ protocolVersion: PROTOCOL_VERSION, ...terminal });
  });

  app.get<{
    Params: { id: string };
    Querystring: { after?: string };
  }>("/api/v1/terminals/:id/output", async (request, reply) => {
    const parsedAfter = Number.parseInt(request.query.after ?? "0", 10);
    const afterSequence = Number.isFinite(parsedAfter) && parsedAfter >= 0 ? parsedAfter : 0;
    const output = terminals.readOutput(request.params.id, afterSequence);
    if (!output) return reply.code(404).send(errorBody("NOT_FOUND", "Terminal not found."));
    return reply.send({
      protocolVersion: PROTOCOL_VERSION,
      terminalId: request.params.id,
      ...output,
    });
  });

  app.delete<{ Params: { id: string } }>("/api/v1/terminals/:id", async (request, reply) => {
    const removed = terminals.remove(request.params.id);
    if (!removed) return reply.code(404).send(errorBody("NOT_FOUND", "Terminal not found."));
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>(
    "/api/v1/ask/threads/:id/turns",
    async (request, reply) => {
      const input = AskTurnRequestSchema.parse(request.body);
      if (input.threadId !== request.params.id) {
        return reply.code(400).send(errorBody("THREAD_MISMATCH", "Thread id does not match URL."));
      }
      if (!input.threadId.startsWith(`${workspaceId}:`)) {
        return reply.code(403).send(
          errorBody(
            "THREAD_WORKSPACE_MISMATCH",
            "The Ask thread belongs to a different workspace.",
            false,
          ),
        );
      }
      return reply
        .code(202)
        .send(
          ask.startTurn(
            request.params.id,
            input.prompt,
            input.requestId,
            input.selectedNodeIds,
          ),
        );
    },
  );

  app.post("/api/v1/act/tasks", async (request, reply) => {
    if (workspace.readOnly) throw new WorkspaceReadOnlyError();
    const input = ActTaskRequestSchema.parse(request.body);
    if (!isSupportedActScope(input.capabilities)) {
      return reply.code(400).send(
        errorBody(
          "UNSUPPORTED_ACT_SCOPE",
          "The MVP supports only the explicit read, write, and command capability set.",
        ),
      );
    }
    if (!codex) throw new CodexUnavailableError("Codex is unavailable.");
    const task = codex.createTask(input.objective, input.capabilities);
    return reply.code(201).send(toPublicActTask(task, workspaceRoot));
  });

  app.post<{ Params: { id: string } }>(
    "/api/v1/act/tasks/:id/approve",
    async (request, reply) => {
      if (workspace.readOnly) throw new WorkspaceReadOnlyError();
      const input = ActApproveRequestSchema.parse(request.body);
      if (input.taskId !== request.params.id) {
        return reply.code(400).send(errorBody("TASK_MISMATCH", "Task id does not match URL."));
      }
      if (!codex) throw new CodexUnavailableError("Codex is unavailable.");
      return toPublicActTask(
        await codex.approve(request.params.id),
        workspaceRoot,
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/act/tasks/:id/cancel",
    async (request) => {
      if (workspace.readOnly) throw new WorkspaceReadOnlyError();
      ProtocolOnlyRequestSchema.parse(request.body);
      if (!codex) throw new CodexUnavailableError("Codex is unavailable.");
      return toPublicActTask(
        await codex.cancel(request.params.id),
        workspaceRoot,
      );
    },
  );

  app.setErrorHandler((error, request, reply) => {
    const normalizedError = error instanceof Error ? error : new Error("Unknown agent error.");
    const mapped = mapError(normalizedError, workspaceRoot);
    database.audit(workspaceId, "http", `${request.method} ${request.routeOptions.url}`, "failed", {
      code: mapped.code,
    });
    const safeMessage = redactLocalPaths(
      redactSecrets(mapped.message),
      workspaceRoot,
    );
    void reply
      .code(mapped.status)
      .send(errorBody(mapped.code, safeMessage, mapped.recoverable));
  });

  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const bundledWebDist = resolve(moduleDirectory, "web");
  const monorepoWebDist = resolve(moduleDirectory, "../../web/dist");
  const defaultWebDist = existsSync(resolve(bundledWebDist, "index.html"))
    ? bundledWebDist
    : monorepoWebDist;
  const webDist = options.webDistPath ?? defaultWebDist;
  if (existsSync(resolve(webDist, "index.html"))) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/",
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send(errorBody("NOT_FOUND", "API route not found."));
      }
      return (reply as FastifyReply & { sendFile(path: string): FastifyReply }).sendFile("index.html");
    });
  } else {
    app.get("/", async () => ({
      name: "Constelix local agent",
      status: "ready",
      message: options.dev ? "Use the Vite development server on port 5173." : "Web assets are not built.",
    }));
  }

    await app.listen({ host: "127.0.0.1", port: options.port ?? (options.dev ? 4321 : 0) });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Unable to determine agent port.");
    const port = address.port;
    boundOrigin = `http://127.0.0.1:${port}`;
    allowedOrigins.add(boundOrigin);
    await indexer.start();
    identityMonitor = startWorkspaceIdentityMonitor(
      workspace,
      events,
      indexer,
      terminals,
      ask,
      codex,
    );

    return {
      app,
      workspaceId,
      capabilityToken,
      port,
      origin: boundOrigin,
      async close() {
        await cleanup();
      },
    };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}

async function cleanupAgentResources(resources: {
  app: FastifyInstance | undefined;
  ask: AskService | undefined;
  codex: CodexManager | undefined;
  terminals: TerminalManager | undefined;
  indexer: WorkspaceIndexer | undefined;
  events: EventBus | undefined;
  database: ConstelixDatabase | undefined;
  lock: WorkspaceLock;
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
  await attempt(async () => resources.indexer?.close());
  await attempt(() => resources.events?.close());
  await attempt(async () => resources.app?.close());
  await attempt(() => resources.database?.close());
  await attempt(() => resources.lock.release());

  if (firstError !== undefined) throw firstError;
}

function hasCapability(request: FastifyRequest, token: string): boolean {
  const authorization = request.headers.authorization;
  return authorization === `Bearer ${token}`;
}

function requestPathname(value: string): string {
  try {
    return new URL(value, "http://127.0.0.1").pathname;
  } catch {
    return "";
  }
}

function hasWebSocketCapability(requestUrl: string, token: string): boolean {
  let candidates: string[];
  try {
    candidates = new URL(requestUrl, "http://127.0.0.1").searchParams.getAll("token");
  } catch {
    return false;
  }
  return candidates.length === 1 && secureTokenEquals(candidates[0] ?? "", token);
}

function secureTokenEquals(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return candidateBytes.length === expectedBytes.length &&
    timingSafeEqual(candidateBytes, expectedBytes);
}

function addCors(reply: FastifyReply, origin: string): void {
  reply.header("Access-Control-Allow-Origin", origin);
  reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  reply.header("Access-Control-Allow-Headers", "Authorization,Content-Type");
  reply.header("Vary", "Origin");
}

function errorBody(code: string, message: string, recoverable = true): Record<string, unknown> {
  return { protocolVersion: PROTOCOL_VERSION, error: { code, message, recoverable } };
}

function isSupportedActScope(capabilities: readonly string[]): boolean {
  const unique = new Set(capabilities);
  return (
    unique.size === 3 &&
    unique.has("read") &&
    unique.has("write") &&
    unique.has("command")
  );
}

function mapError(error: Error, workspaceRoot?: string): {
  status: number;
  code: string;
  message: string;
  recoverable: boolean;
} {
  if (error instanceof ZodError) {
    return { status: 400, code: "INVALID_REQUEST", message: "Request validation failed.", recoverable: true };
  }
  if (error instanceof FileConflictError) {
    return { status: 409, code: error.code, message: error.message, recoverable: true };
  }
  if (error instanceof FileTooLargeError) {
    return { status: 413, code: error.code, message: error.message, recoverable: true };
  }
  if (error instanceof PathSecurityError) {
    return { status: 403, code: error.code, message: error.message, recoverable: false };
  }
  if (error instanceof WorkspaceReadOnlyError) {
    return { status: 403, code: error.code, message: error.message, recoverable: true };
  }
  if (error instanceof WorkspaceIdentityError) {
    return { status: 409, code: error.code, message: error.message, recoverable: false };
  }
  if (error instanceof WorkspaceValidationError) {
    const status = error.code === "WORKSPACE_NOT_FOUND" ? 404 : 403;
    return { status, code: error.code, message: error.message, recoverable: false };
  }
  if (error instanceof LlmConfigurationError) {
    return { status: 400, code: error.code, message: error.message, recoverable: true };
  }
  if (error instanceof OpenAIUnavailableError || error instanceof CodexUnavailableError) {
    return { status: 503, code: error.code, message: error.message, recoverable: true };
  }
  if (error instanceof ReadOnlyTerminalUnavailableError) {
    return { status: 503, code: error.code, message: error.message, recoverable: true };
  }
  const nodeError = error as NodeJS.ErrnoException;
  if (nodeError.code === "ENOENT") {
    return { status: 404, code: "NOT_FOUND", message: "Resource not found.", recoverable: true };
  }
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: redactLocalPaths(
      redactSecrets(error.message || "Internal agent error."),
      workspaceRoot,
    ),
    recoverable: true,
  };
}

export function createWorkspaceId(root: string): string {
  try {
    return createCanonicalWorkspaceId(realpathSync(resolve(root)));
  } catch {
    return createCanonicalWorkspaceId(resolve(root));
  }
}

function startWorkspaceIdentityMonitor(
  workspace: WorkspaceDescriptor,
  events: EventBus,
  indexer: WorkspaceIndexer,
  terminals: TerminalManager,
  ask: AskService,
  codex: CodexManager | undefined,
): NodeJS.Timeout {
  let checking = false;
  let failed = false;
  const timer = setInterval(() => {
    if (checking || failed) return;
    checking = true;
    void assertWorkspaceIdentity(workspace)
      .catch(() => {
        failed = true;
        events.publish("error", {
          code: "WORKSPACE_ROOT_CHANGED",
          message:
            "La raíz del workspace cambió. Se detuvieron terminales, IA e indexación para proteger el aislamiento.",
          recoverable: false,
          severity: "error",
        });
        ask.close();
        terminals.close();
        codex?.close();
        void indexer.close().catch(() => undefined);
      })
      .finally(() => {
        checking = false;
      });
  }, 500);
  timer.unref();
  return timer;
}

class WorkspaceLock {
  private constructor(
    private readonly path: string,
    private readonly handle: Awaited<ReturnType<typeof open>>,
    private readonly nonce: string,
  ) {}

  static async acquire(path: string, workspaceId: string): Promise<WorkspaceLock> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, "wx", 0o600);
        const nonce = randomUUID();
        await handle.writeFile(JSON.stringify({
          pid: process.pid,
          nonce,
          workspaceId,
          createdAt: new Date().toISOString(),
        }));
        await handle.sync();
        return new WorkspaceLock(path, handle, nonce);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let stale = false;
        try {
          const content = await readFile(path, "utf8");
          const parsed = parseLockOwner(content);
          const pid = parsed?.pid ?? Number.parseInt(content, 10);
          if (!Number.isFinite(pid)) stale = true;
          else process.kill(pid, 0);
        } catch (checkError) {
          const code = (checkError as NodeJS.ErrnoException).code;
          stale = code === "ESRCH" || code === "ENOENT";
        }
        if (!stale) {
          throw new Error(
            "El workspace ya está abierto por otra instancia de Constelix.",
          );
        }
        await unlink(path).catch(() => undefined);
      }
    }
    throw new Error("Unable to acquire the workspace lock.");
  }

  async release(): Promise<void> {
    await this.handle.close().catch(() => undefined);
    try {
      const owner = parseLockOwner(await readFile(this.path, "utf8"));
      if (owner?.nonce === this.nonce) await unlink(this.path);
    } catch {
      // The lock may already be gone after a crash or external cleanup.
    }
  }
}

function parseLockOwner(
  value: string,
): { pid: number; nonce?: string } | undefined {
  try {
    const parsed = JSON.parse(value) as { pid?: unknown; nonce?: unknown };
    if (typeof parsed.pid !== "number") return undefined;
    return {
      pid: parsed.pid,
      ...(typeof parsed.nonce === "string" ? { nonce: parsed.nonce } : {}),
    };
  } catch {
    return undefined;
  }
}

function assertStatePathOutsideWorkspace(
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

function sanitizePublicPayload(
  value: unknown,
  workspaceRoot: string,
): unknown {
  if (typeof value === "string") {
    return redactLocalPaths(redactSecrets(value), workspaceRoot);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePublicPayload(item, workspaceRoot));
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sanitizePublicPayload(item, workspaceRoot),
    ]),
  );
}

function toPublicActTask(
  task: {
    id: string;
    scope: ActTask["scope"];
    status: ActTask["status"];
    createdAt: string;
    approvedAt?: string;
    completedAt?: string;
    error?: string;
  },
  workspaceRoot: string,
): ActTask {
  return {
    protocolVersion: PROTOCOL_VERSION,
    id: task.id,
    scope: {
      ...task.scope,
      rootPath: summarizeWorkspacePath(workspaceRoot),
    },
    status: task.status,
    createdAt: task.createdAt,
    ...(task.approvedAt === undefined
      ? {}
      : { approvedAt: task.approvedAt }),
    ...(task.completedAt === undefined
      ? {}
      : { completedAt: task.completedAt }),
    ...(task.error === undefined
      ? {}
      : {
          error: redactLocalPaths(
            redactSecrets(task.error),
            workspaceRoot,
          ),
        }),
  };
}
