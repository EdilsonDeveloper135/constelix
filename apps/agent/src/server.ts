import {
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import {
  ActApproveRequestSchema,
  ActTaskRequestSchema,
  AskTurnRequestSchema,
  FileReadRequestSchema,
  FileWriteRequestSchema,
  GraphQuerySchema,
  LayoutWriteRequestSchema,
  LlmConfigurationUpdateSchema,
  LspLanguageSchema,
  PROTOCOL_VERSION,
  ProtocolOnlyRequestSchema,
  TerminalCreateRequestSchema,
  WorkspaceOpenRequestSchema,
  WorkspaceSessionSchema,
  type ActTask,
} from "@constelix/contracts";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { type AskServiceOptions } from "./ask.js";
import {
  CodexUnavailableError,
  type CodexManagerOptions,
} from "./codex.js";
import {
  readWorkspaceTextFile,
  writeWorkspaceTextFile,
} from "./files.js";
import { testLlmConnection } from "./llm-connection.js";
import { chooseNativeWorkspaceFolder } from "./native-folder-picker.js";
import {
  LspSessionLimitError,
} from "./lsp.js";
import {
  detectSupportedLanguage,
  type ScanWorkspaceOptions,
} from "./scanner.js";
import {
  WorkspaceReadOnlyError,
  createWorkspaceId as createCanonicalWorkspaceId,
  redactLocalPaths,
  redactSecrets,
  summarizeWorkspacePath,
} from "./security.js";
import {
  WorkspaceBrowserError,
} from "./workspace-browser.js";
import {
  WorkspaceRuntimeManager,
  WorkspaceSessionChangedError,
} from "./workspace-manager.js";
import type { WorkspaceRuntime } from "./workspace-runtime.js";
import { mapAgentError } from "./server-errors.js";

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
  globalDatabasePath?: string;
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

export async function startAgentServer(
  options: AgentServerOptions,
): Promise<RunningAgentServer> {
  const capabilityToken =
    options.capabilityToken ?? randomBytes(32).toString("base64url");
  const manager = await WorkspaceRuntimeManager.create({
    workspaceRoot: options.workspaceRoot,
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options.storageDirectory
      ? { storageDirectory: options.storageDirectory }
      : {}),
    ...(options.databasePath ? { databasePath: options.databasePath } : {}),
    ...(options.globalDatabasePath
      ? { globalDatabasePath: options.globalDatabasePath }
      : {}),
    ...(options.askOptions ? { askOptions: options.askOptions } : {}),
    ...(options.codexOptions ? { codexOptions: options.codexOptions } : {}),
    ...(options.indexerScanOptions
      ? { indexerScanOptions: options.indexerScanOptions }
      : {}),
    agentVersion: "v0.0.7",
  });
  const events = manager.globalEvents;
  const app = Fastify({
    // WebSocket authentication necessarily places the capability in the
    // in-memory upgrade URL. Fastify request logging must remain disabled so
    // that URL can never persist the credential.
    logger: false,
    bodyLimit: 2 * 1024 * 1024 + 64 * 1024,
  });
  let closing = false;
  let cleanupPromise: Promise<void> | undefined;

  const cleanup = (): Promise<void> => {
    cleanupPromise ??= closeServerResources();
    return cleanupPromise;
  };
  const closeServerResources = async (): Promise<void> => {
    closing = true;
    let firstError: unknown;
    const attempt = async (
      action: () => void | Promise<void>,
    ): Promise<void> => {
      try {
        await action();
      } catch (error) {
        firstError ??= error;
      }
    };
    events.close();
    await attempt(() => manager.close());
    await attempt(() => app.close());
    if (firstError !== undefined) throw firstError;
  };

  try {
    await app.register(fastifyWebsocket, {
      options: { maxPayload: 1024 * 1024, perMessageDeflate: false },
    });
    let boundOrigin: string | undefined;
    const allowedOrigins = new Set<string>();
    if (options.dev) {
      allowedOrigins.add(options.devOrigin ?? "http://127.0.0.1:5173");
      allowedOrigins.add("http://localhost:5173");
    }

    app.addHook("onRequest", async (request, reply) => {
      const pathname = requestPathname(request.url);
      if (!isApiRequest(request, pathname)) return;
      if (closing) {
        return reply
          .code(503)
          .send(errorBody("AGENT_CLOSING", "El agente local se está cerrando."));
      }
      const origin = request.headers.origin;
      if (
        origin &&
        !allowedOrigins.has(origin) &&
        origin !== boundOrigin
      ) {
        return reply
          .code(403)
          .send(errorBody("INVALID_ORIGIN", "Request origin is not allowed."));
      }
      if (
        boundOrigin &&
        request.headers.host !== new URL(boundOrigin).host
      ) {
        return reply
          .code(403)
          .send(errorBody("INVALID_HOST", "Request host is not allowed."));
      }
      if (request.method === "OPTIONS") {
        if (origin && allowedOrigins.has(origin)) addCors(reply, origin);
        return reply.code(204).send();
      }
      if (pathname === "/api/v1/events" || pathname === "/api/v1/lsp") {
        if (
          !origin ||
          (!allowedOrigins.has(origin) && origin !== boundOrigin)
        ) {
          return reply.code(403).send(
            errorBody(
              "INVALID_ORIGIN",
              "A valid WebSocket origin is required.",
            ),
          );
        }
        if (!hasWebSocketCapability(request.url, capabilityToken)) {
          return reply.code(401).send(
            errorBody(
              "UNAUTHORIZED",
              "A valid WebSocket capability token is required.",
            ),
          );
        }
        await manager.current.assertHealthy();
        return;
      }
      if (!hasCapability(request, capabilityToken)) {
        return reply.code(401).send(
          errorBody("UNAUTHORIZED", "A valid capability token is required."),
        );
      }
      const requestedSession = requestSessionId(request);
      if (
        !isWorkspaceSessionOptionalRequest(pathname, request.method) &&
        !WorkspaceSessionSchema.shape.id.safeParse(requestedSession).success
      ) {
        throw new WorkspaceSessionChangedError(manager.current.session);
      }
      const runtime = manager.capture(requestedSession);
      if (!isGlobalWorkspaceControlRequest(pathname, request.method)) {
        await runtime.assertHealthy();
      }
    });

    app.addHook("onSend", async (request, reply, payload) => {
      const origin = request.headers.origin;
      if (origin && allowedOrigins.has(origin)) addCors(reply, origin);
      reply.header(
        "Cache-Control",
        isApiRequest(request) ? "no-store" : "no-cache",
      );
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("X-Frame-Options", "DENY");
      reply.header("Referrer-Policy", "no-referrer");
      reply.header("Cross-Origin-Resource-Policy", "same-origin");
      reply.header("Cross-Origin-Opener-Policy", "same-origin");
      reply.header(
        "Permissions-Policy",
        "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
      );
      reply.header(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          "base-uri 'none'",
          "object-src 'none'",
          "frame-ancestors 'none'",
          "form-action 'none'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
          "worker-src 'self' blob:",
        ].join("; "),
      );
      return payload;
    });

    app.get("/api/v1/events", { websocket: true }, (socket) => {
      events.attachAuthenticated(socket as never);
      void manager.current.assertHealthy().catch(() => {
        socket.close(4409, "Workspace isolation changed");
      });
    });

    app.get<{
      Querystring: { language?: string; session?: string };
    }>("/api/v1/lsp", { websocket: true }, (socket, request) => {
      const language = LspLanguageSchema.safeParse(request.query.language);
      if (!language.success) {
        socket.close(4400, "Unsupported language");
        return;
      }
      const session = WorkspaceSessionSchema.shape.id.safeParse(
        request.query.session,
      );
      if (!session.success) {
        socket.close(4409, "Workspace session required");
        return;
      }
      let runtime: WorkspaceRuntime;
      try {
        runtime = manager.capture(session.data);
      } catch {
        socket.close(4409, "Workspace session changed");
        return;
      }
      void runtime.lsp
        .attach(socket as never, language.data)
        .catch((error: unknown) => {
          const code =
            error instanceof LspSessionLimitError ? 4429 : 4410;
          socket.close(code, safeSocketReason(error));
        });
    });

    app.get("/api/v1/health", async (request) => {
      const runtime = captureRequest(manager, request);
      const mem = process.memoryUsage();
      return {
        protocolVersion: PROTOCOL_VERSION,
        status: "ok",
        workspaceId: runtime.workspaceId,
        session: runtime.session,
        index: runtime.indexer.status,
        uptime: process.uptime(),
        memoryUsage: mem.rss,
        nodeCount: runtime.indexer.graph.nodeCount,
        edgeCount: runtime.indexer.graph.edgeCount,
      };
    });

    app.get("/api/v1/bootstrap", async (request) =>
      buildBootstrap(captureRequest(manager, request))
    );

    app.get("/api/v1/workspaces", async (request) => {
      const runtime = captureRequest(manager, request);
      return {
        protocolVersion: PROTOCOL_VERSION,
        activeSession: runtime.session,
        recents: await manager.listRecentWorkspaces(),
      };
    });

    app.post("/api/v1/workspaces/open", async (request) => {
      const input = WorkspaceOpenRequestSchema.parse(request.body);
      const headerSession = requestSessionId(request);
      if (headerSession && headerSession !== input.expectedSessionId) {
        throw new WorkspaceSessionChangedError(manager.current.session);
      }
      const runtime = await manager.open({
        target: input.target,
        expectedSessionId: input.expectedSessionId,
        ...(input.readOnly === undefined
          ? {}
          : { readOnly: input.readOnly }),
        ...(input.lockResolution === undefined
          ? {}
          : { lockResolution: input.lockResolution }),
      });
      return {
        protocolVersion: PROTOCOL_VERSION,
        session: runtime.session,
        bootstrap: buildBootstrap(runtime),
      };
    });

    app.get<{
      Querystring: {
        path?: string;
        showHidden?: string;
        cursor?: string;
        limit?: string;
      };
    }>("/api/v1/fs/browse", async (request) => {
      captureRequest(manager, request);
      const showHidden = parseBooleanQuery(
        request.query.showHidden,
        "showHidden",
      );
      const limit = parsePositiveIntegerQuery(request.query.limit, "limit");
      const page = await manager.browse({
        path: request.query.path || homedir(),
        ...(showHidden === undefined ? {} : { showHidden }),
        ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
        ...(limit === undefined ? {} : { limit }),
      });
      return {
        protocolVersion: PROTOCOL_VERSION,
        path: page.path,
        parentPath: page.parentPath ?? null,
        entries: page.entries
          .filter((entry) => entry.readable)
          .map((entry) => ({
            name: entry.name,
            path: entry.path,
            symlink: entry.symbolicLink,
          })),
        ...(page.nextCursor ? { cursor: page.nextCursor } : {}),
        truncated: page.truncated,
      };
    });

    app.post("/api/v1/fs/pick-folder", async (request) => {
      captureRequest(manager, request);
      return chooseNativeWorkspaceFolder();
    });

    app.get("/api/v1/settings/llm", async (request) =>
      captureRequest(manager, request).ask.llmConfiguration
    );

    app.put("/api/v1/settings/llm", async (request) => {
      const runtime = captureRequest(manager, request);
      const input = LlmConfigurationUpdateSchema.parse(request.body);
      const configuration =
        await runtime.llmConfigurationStore.update(input);
      const publicConfiguration = runtime.ask.reconfigure(configuration);
      runtime.database.audit(
        runtime.workspaceId,
        "settings",
        "llm.update",
        "success",
        {
          baseUrl: publicConfiguration.baseUrl,
          model: publicConfiguration.model,
          providerKind: publicConfiguration.providerKind,
          apiKeyAction: input.apiKey.action,
          apiKeyConfigured: publicConfiguration.apiKeyConfigured,
        },
      );
      return publicConfiguration;
    });

    app.post("/api/v1/settings/llm/test", async (request) => {
      const runtime = captureRequest(manager, request);
      const input = LlmConfigurationUpdateSchema.parse(request.body);
      const configuration = await runtime.llmConfigurationStore.preview(input);
      const result = await testLlmConnection(configuration);
      runtime.database.audit(
        runtime.workspaceId,
        "settings",
        "llm.test",
        result.ok ? "success" : "failure",
        {
          providerKind: result.providerKind,
          model: result.model,
          latencyMs: result.latencyMs,
        },
      );
      return result;
    });

    app.post("/api/v1/graph/query", async (request) => {
      const runtime = captureRequest(manager, request);
      return runtime.indexer.query(GraphQuerySchema.parse(request.body));
    });

    app.post("/api/v1/files/read", async (request) => {
      const runtime = captureRequest(manager, request);
      const input = FileReadRequestSchema.parse(request.body);
      const file = await readWorkspaceTextFile(
        runtime.workspace,
        input.relativePath,
      );
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
      const runtime = captureRequest(manager, request);
      const input = FileWriteRequestSchema.parse(request.body);
      const file = await writeWorkspaceTextFile(runtime.workspace, {
        relativePath: input.relativePath,
        content: input.content,
        expectedContentHash: input.expectedContentHash,
      });
      runtime.database.audit(
        runtime.workspaceId,
        "file",
        "write",
        "success",
        {
          relativePath: input.relativePath,
          sizeBytes: file.sizeBytes,
        },
      );
      runtime.indexer.notifyPathChanged(input.relativePath, 25);
      return {
        protocolVersion: PROTOCOL_VERSION,
        relativePath: input.relativePath,
        contentHash: file.contentHash,
        modifiedAt: new Date(file.mtimeMs).toISOString(),
        graphRevision: runtime.indexer.graph.revision,
      };
    });

    app.put("/api/v1/layout", async (request) => {
      const runtime = captureRequest(manager, request);
      const input = LayoutWriteRequestSchema.parse(request.body);
      const revision =
        input.revision ?? runtime.indexer.graph.revision;
      const saved = runtime.database.saveLayout(
        runtime.workspaceId,
        revision,
        input.panels,
      );
      return { protocolVersion: PROTOCOL_VERSION, saved, revision };
    });

    app.post("/api/v1/terminals", async (request, reply) => {
      const runtime = captureRequest(manager, request);
      const input = TerminalCreateRequestSchema.parse(request.body);
      const terminal = await runtime.terminals.create({
        cwd: input.cwd,
        cols: input.columns,
        rows: input.rows,
        ...(input.shell === undefined ? {} : { shell: input.shell }),
        ...(input.panelId === undefined ? {} : { panelId: input.panelId }),
      });
      runtime.database.audit(
        runtime.workspaceId,
        "terminal",
        "create",
        "success",
        { cwd: input.cwd ?? "." },
      );
      return reply
        .code(201)
        .send({ protocolVersion: PROTOCOL_VERSION, ...terminal });
    });

    app.get<{
      Params: { id: string };
      Querystring: { after?: string };
    }>("/api/v1/terminals/:id/output", async (request, reply) => {
      const runtime = captureRequest(manager, request);
      const parsedAfter = Number.parseInt(request.query.after ?? "0", 10);
      const afterSequence =
        Number.isFinite(parsedAfter) && parsedAfter >= 0 ? parsedAfter : 0;
      const output = runtime.terminals.readOutput(
        request.params.id,
        afterSequence,
      );
      if (!output) {
        return reply
          .code(404)
          .send(errorBody("NOT_FOUND", "Terminal not found."));
      }
      return reply.send({
        protocolVersion: PROTOCOL_VERSION,
        terminalId: request.params.id,
        ...output,
      });
    });

    app.delete<{ Params: { id: string } }>(
      "/api/v1/terminals/:id",
      async (request, reply) => {
        const runtime = captureRequest(manager, request);
        const removed = runtime.terminals.remove(request.params.id);
        if (!removed) {
          return reply
            .code(404)
            .send(errorBody("NOT_FOUND", "Terminal not found."));
        }
        return reply.code(204).send();
      },
    );

    app.post<{ Params: { id: string } }>(
      "/api/v1/ask/threads/:id/turns",
      async (request, reply) => {
        const runtime = captureRequest(manager, request);
        const input = AskTurnRequestSchema.parse(request.body);
        if (input.threadId !== request.params.id) {
          return reply.code(400).send(
            errorBody("THREAD_MISMATCH", "Thread id does not match URL."),
          );
        }
        if (!input.threadId.startsWith(`${runtime.workspaceId}:`)) {
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
            runtime.ask.startTurn(
              request.params.id,
              input.prompt,
              input.requestId,
              input.selectedNodeIds,
            ),
          );
      },
    );

    app.post("/api/v1/act/tasks", async (request, reply) => {
      const runtime = captureRequest(manager, request);
      if (runtime.workspace.readOnly) throw new WorkspaceReadOnlyError();
      const input = ActTaskRequestSchema.parse(request.body);
      if (!isSupportedActScope(input.capabilities)) {
        return reply.code(400).send(
          errorBody(
            "UNSUPPORTED_ACT_SCOPE",
            "The MVP supports only the explicit read, write, and command capability set.",
          ),
        );
      }
      if (!runtime.codex) {
        throw new CodexUnavailableError("Codex is unavailable.");
      }
      const task = runtime.codex.createTask(
        input.objective,
        input.capabilities,
      );
      return reply
        .code(201)
        .send(toPublicActTask(task, runtime.workspaceRoot));
    });

    app.post<{ Params: { id: string } }>(
      "/api/v1/act/tasks/:id/approve",
      async (request, reply) => {
        const runtime = captureRequest(manager, request);
        if (runtime.workspace.readOnly) throw new WorkspaceReadOnlyError();
        const input = ActApproveRequestSchema.parse(request.body);
        if (input.taskId !== request.params.id) {
          return reply.code(400).send(
            errorBody("TASK_MISMATCH", "Task id does not match URL."),
          );
        }
        if (!runtime.codex) {
          throw new CodexUnavailableError("Codex is unavailable.");
        }
        return toPublicActTask(
          await runtime.codex.approve(request.params.id),
          runtime.workspaceRoot,
        );
      },
    );

    app.post<{ Params: { id: string } }>(
      "/api/v1/act/tasks/:id/cancel",
      async (request) => {
        const runtime = captureRequest(manager, request);
        if (runtime.workspace.readOnly) throw new WorkspaceReadOnlyError();
        ProtocolOnlyRequestSchema.parse(request.body);
        if (!runtime.codex) {
          throw new CodexUnavailableError("Codex is unavailable.");
        }
        return toPublicActTask(
          await runtime.codex.cancel(request.params.id),
          runtime.workspaceRoot,
        );
      },
    );

    app.setErrorHandler((error, request, reply) => {
      const normalized =
        error instanceof Error ? error : new Error("Unknown agent error.");
      const runtime = manager.current;
      const mapped = mapAgentError(normalized);
      try {
        runtime.database.audit(
          runtime.workspaceId,
          "http",
          `${request.method} ${request.routeOptions.url}`,
          "failed",
          { code: mapped.code },
        );
      } catch {
        // Error reporting must remain available during runtime teardown.
      }
      const safeMessage = redactLocalPaths(
        redactSecrets(mapped.message),
        runtime.workspaceRoot,
      );
      void reply
        .code(mapped.status)
        .send(
          errorBody(
            mapped.code,
            safeMessage,
            mapped.recoverable,
            mapped.details,
          ),
        );
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
        if (isApiRequest(request)) {
          return reply
            .code(404)
            .send(errorBody("NOT_FOUND", "API route not found."));
        }
        return (
          reply as FastifyReply & { sendFile(path: string): FastifyReply }
        ).sendFile("index.html");
      });
    } else {
      app.get("/", async () => ({
        name: "Constelix local agent",
        status: "ready",
        message: options.dev
          ? "Use the Vite development server on port 5173."
          : "Web assets are not built.",
      }));
    }

    await app.listen({
      host: "127.0.0.1",
      port: options.port ?? (options.dev ? 4321 : 0),
    });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to determine agent port.");
    }
    const port = address.port;
    boundOrigin = `http://127.0.0.1:${port}`;
    allowedOrigins.add(boundOrigin);

    return {
      app,
      workspaceId: manager.current.workspaceId,
      capabilityToken,
      port,
      origin: boundOrigin,
      close: cleanup,
    };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}

function isGlobalWorkspaceControlRequest(
  pathname: string,
  method: string,
): boolean {
  return (
    (pathname === "/api/v1/workspaces" && method === "GET") ||
    (pathname === "/api/v1/workspaces/open" && method === "POST") ||
    (pathname === "/api/v1/fs/browse" && method === "GET")
  );
}

function isWorkspaceSessionOptionalRequest(
  pathname: string,
  method: string,
): boolean {
  return (
    isGlobalWorkspaceControlRequest(pathname, method) ||
    (pathname === "/api/v1/bootstrap" && method === "GET") ||
    (pathname === "/api/v1/health" && method === "GET")
  );
}

function buildBootstrap(runtime: WorkspaceRuntime): Record<string, unknown> {
  const graph = runtime.indexer.graph.snapshot(500);
  const savedLayout = runtime.database.loadLayout(runtime.workspaceId) ?? {
    revision: 0,
    panels: [],
  };
  const codexAvailability = runtime.codex?.peekAvailability() ?? {
    available: false,
    checking: false,
    reason: "Actuar está deshabilitado en Modo Lectura.",
  };
  const activeActTask = runtime.codex?.activeTask ?? null;
  const total = runtime.indexer.status.total;
  return {
    protocolVersion: PROTOCOL_VERSION,
    session: runtime.session,
    workspace: {
      id: runtime.workspaceId,
      name: basename(runtime.workspaceRoot),
      rootPath: summarizeWorkspacePath(runtime.workspaceRoot),
      mode: runtime.workspace.mode,
      readOnly: runtime.workspace.readOnly,
    },
    summary: runtime.indexer.status.summary,
    graph,
    layout: savedLayout.panels,
    layoutState: savedLayout,
    conversation: runtime.database.loadAiMessages(
      `${runtime.workspaceId}:main`,
      runtime.workspaceId,
    ),
    activeAskTurnIds: runtime.ask.activeTurnIds,
    activeActTask: activeActTask
      ? toPublicActTask(activeActTask, runtime.workspaceRoot)
      : null,
    index: {
      ...runtime.indexer.status,
      progress:
        total === 0 ? 0 : runtime.indexer.status.completed / total,
      filesIndexed: runtime.indexer.indexedFileCount,
      symbolsIndexed: runtime.indexer.graph.nodeCount,
      edgesIndexed: runtime.indexer.graph.edgeCount,
    },
    terminals: runtime.terminals.list(),
    capabilities: {
      ask: true,
      askMode: runtime.ask.mode,
      askProviderStatus: runtime.ask.providerStatus,
      askNotice: runtime.ask.notice,
      llm: runtime.ask.llmConfiguration,
      act: !runtime.workspace.readOnly && codexAvailability.available,
      terminal: true,
      codexReason: codexAvailability.reason,
      codexChecking: codexAvailability.checking,
      codexVersion: codexAvailability.version,
      model: runtime.ask.model,
      languages: ["javascript", "typescript", "python"],
      lsp: runtime.availability(),
    },
  };
}

function captureRequest(
  manager: WorkspaceRuntimeManager,
  request: FastifyRequest,
): WorkspaceRuntime {
  return manager.capture(requestSessionId(request));
}

function requestSessionId(request: FastifyRequest): string | undefined {
  const value = request.headers["x-constelix-workspace-session"];
  return typeof value === "string" && value ? value : undefined;
}

function hasCapability(request: FastifyRequest, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

function requestPathname(value: string): string {
  try {
    return decodeURIComponent(
      new URL(value, "http://127.0.0.1").pathname,
    );
  } catch {
    return "";
  }
}

function isApiRequest(
  request: FastifyRequest,
  pathname = requestPathname(request.url),
): boolean {
  const routePath = request.routeOptions.url;
  return (
    pathname.startsWith("/api/") ||
    (typeof routePath === "string" && routePath.startsWith("/api/"))
  );
}

function hasWebSocketCapability(
  requestUrl: string,
  token: string,
): boolean {
  let candidates: string[];
  try {
    candidates = new URL(
      requestUrl,
      "http://127.0.0.1",
    ).searchParams.getAll("token");
  } catch {
    return false;
  }
  return (
    candidates.length === 1 &&
    secureTokenEquals(candidates[0] ?? "", token)
  );
}

function secureTokenEquals(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    candidateBytes.length === expectedBytes.length &&
    timingSafeEqual(candidateBytes, expectedBytes)
  );
}

function addCors(reply: FastifyReply, origin: string): void {
  reply.header("Access-Control-Allow-Origin", origin);
  reply.header(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,DELETE,OPTIONS",
  );
  reply.header(
    "Access-Control-Allow-Headers",
    "Authorization,Content-Type,X-Constelix-Protocol,X-Constelix-Workspace-Session",
  );
  reply.header("Vary", "Origin");
}

function errorBody(
  code: string,
  message: string,
  recoverable = true,
  details?: unknown,
): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    error: {
      code,
      message,
      recoverable,
      ...(details === undefined ? {} : { details }),
    },
  };
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

function parseBooleanQuery(
  value: string | undefined,
  label: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new WorkspaceBrowserError(
    "WORKSPACE_PATH_INVALID",
    `${label} debe ser true o false.`,
  );
}

function parsePositiveIntegerQuery(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new WorkspaceBrowserError(
      "WORKSPACE_BROWSE_LIMIT_INVALID",
      `${label} debe ser un entero positivo.`,
    );
  }
  return Number.parseInt(value, 10);
}

function safeSocketReason(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "LSP unavailable";
  return redactSecrets(message).slice(0, 120);
}

export function createWorkspaceId(root: string): string {
  try {
    return createCanonicalWorkspaceId(realpathSync(resolve(root)));
  } catch {
    return createCanonicalWorkspaceId(resolve(root));
  }
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
