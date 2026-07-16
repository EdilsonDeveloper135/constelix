import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { z, ZodError } from "zod";
import {
  FileReadRequestSchema,
  FileWriteRequestSchema,
  GraphQuerySchema,
  PROTOCOL_VERSION,
  TerminalCreateRequestSchema,
  type PanelState,
} from "@constelix/contracts";
import { AskService, DEFAULT_ASK_MODEL, OpenAIUnavailableError } from "./ask.js";
import { CodexManager, CodexUnavailableError } from "./codex.js";
import { ConstelixDatabase } from "./database.js";
import { EventBus } from "./events.js";
import {
  FileConflictError,
  FileTooLargeError,
  readWorkspaceTextFile,
  writeWorkspaceTextFile,
} from "./files.js";
import { WorkspaceIndexer } from "./indexer.js";
import { detectSupportedLanguage } from "./scanner.js";
import { PathSecurityError, redactSecrets } from "./security.js";
import { TerminalManager } from "./terminals.js";

const LayoutWriteSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  revision: z.number().int().nonnegative().optional(),
  panels: z.array(z.record(z.string(), z.unknown())).max(100),
});

const AskTurnCompatSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  prompt: z.string().trim().min(1).max(20_000),
  selectedNodeIds: z.array(z.string()).max(50).optional(),
});

const ActTaskCompatSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  objective: z.string().trim().min(1).max(20_000),
  capabilities: z.array(z.string()).min(1).optional(),
  outsideWorkspace: z.literal("deny").optional(),
});

const ActApproveCompatSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  taskId: z.string().min(1).optional(),
  approved: z.literal(true).optional(),
});

export interface AgentServerOptions {
  workspaceRoot: string;
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
  const workspaceId = createWorkspaceId(options.workspaceRoot);
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
  await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
  const lock = await WorkspaceLock.acquire(resolve(storageDirectory, "agent.lock"));
  const database = new ConstelixDatabase(
    options.databasePath ?? resolve(storageDirectory, "constelix.sqlite"),
  );
  database.upsertWorkspace(workspaceId, options.workspaceRoot);

  const events = new EventBus();
  const indexer = new WorkspaceIndexer(workspaceId, options.workspaceRoot, database, events);
  const terminals = new TerminalManager(options.workspaceRoot, events);
  const ask = new AskService(workspaceId, options.workspaceRoot, indexer.graph, database, events);
  const codex = new CodexManager(workspaceId, options.workspaceRoot, events, database);
  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024 + 64 * 1024,
  });

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
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin) && origin !== boundOrigin) {
      return reply.code(403).send(errorBody("INVALID_ORIGIN", "Request origin is not allowed."));
    }
    if (boundOrigin && request.headers.host !== new URL(boundOrigin).host) {
      const isDevProxy = options.dev && request.headers.host === "127.0.0.1:4321";
      if (!isDevProxy) {
        return reply.code(403).send(errorBody("INVALID_HOST", "Request host is not allowed."));
      }
    }
    if (request.method === "OPTIONS") {
      if (origin && allowedOrigins.has(origin)) addCors(reply, origin);
      return reply.code(204).send();
    }
    if (request.url === "/api/v1/events") return;
    if (!hasCapability(request, capabilityToken)) {
      return reply.code(401).send(errorBody("UNAUTHORIZED", "A valid capability token is required."));
    }
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

  app.get("/api/v1/events", { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin) && origin !== boundOrigin) {
      socket.close(4403, "Origin not allowed");
      return;
    }
    events.attach(socket as never, capabilityToken);
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
    const codexAvailability = await codex.availability();
    const total = indexer.status.total;
    return {
      protocolVersion: PROTOCOL_VERSION,
      workspace: {
        id: workspaceId,
        name: basename(options.workspaceRoot),
        rootPath: options.workspaceRoot,
      },
      graph,
      layout: savedLayout.panels,
      layoutState: savedLayout,
      conversation: database.loadAiMessages(`${workspaceId}:main`),
      index: {
        ...indexer.status,
        progress: total === 0 ? 0 : indexer.status.completed / total,
        filesIndexed: indexer.indexedFileCount,
        symbolsIndexed: graph.nodes.length,
        edgesIndexed: graph.edges.length,
      },
      terminals: terminals.list(),
      capabilities: {
        ask: ask.available,
        act: codexAvailability.available,
        terminal: true,
        codexReason: codexAvailability.reason,
        model: process.env.CONSTELIX_OPENAI_MODEL ?? DEFAULT_ASK_MODEL,
        languages: ["javascript", "typescript", "python"],
      },
    };
  });

  app.post("/api/v1/graph/query", async (request) => {
    const query = GraphQuerySchema.parse(request.body);
    return indexer.query(query);
  });

  app.post("/api/v1/files/read", async (request) => {
    const input = FileReadRequestSchema.parse(request.body);
    const file = await readWorkspaceTextFile(options.workspaceRoot, input.relativePath);
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
    const file = await writeWorkspaceTextFile(options.workspaceRoot, {
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
    const input = LayoutWriteSchema.parse(request.body);
    const revision = input.revision ?? indexer.graph.revision;
    database.saveLayout(workspaceId, revision, input.panels as PanelState[]);
    return { protocolVersion: PROTOCOL_VERSION, saved: true, revision };
  });

  app.post("/api/v1/terminals", async (request, reply) => {
    const input = TerminalCreateRequestSchema.parse(request.body);
    const terminal = await terminals.create({
      cwd: input.cwd,
      cols: input.columns,
      rows: input.rows,
      ...(input.shell === undefined ? {} : { shell: input.shell }),
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
      const input = AskTurnCompatSchema.parse(request.body);
      if (input.threadId !== undefined && input.threadId !== request.params.id) {
        return reply.code(400).send(errorBody("THREAD_MISMATCH", "Thread id does not match URL."));
      }
      return reply
        .code(202)
        .send(
          ask.startTurn(
            request.params.id,
            input.prompt,
            input.requestId ?? randomUUID(),
            input.selectedNodeIds ?? [],
          ),
        );
    },
  );

  app.post("/api/v1/act/tasks", async (request, reply) => {
    const input = ActTaskCompatSchema.parse(request.body);
    const task = codex.createTask(input.objective);
    return reply.code(201).send({ protocolVersion: PROTOCOL_VERSION, ...task });
  });

  app.post<{ Params: { id: string } }>(
    "/api/v1/act/tasks/:id/approve",
    async (request, reply) => {
      const input = ActApproveCompatSchema.parse(request.body);
      if (input.taskId !== undefined && input.taskId !== request.params.id) {
        return reply.code(400).send(errorBody("TASK_MISMATCH", "Task id does not match URL."));
      }
      return { protocolVersion: PROTOCOL_VERSION, ...(await codex.approve(request.params.id)) };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/act/tasks/:id/cancel",
    async (request) => ({
      protocolVersion: PROTOCOL_VERSION,
      ...(await codex.cancel(request.params.id)),
    }),
  );

  app.setErrorHandler((error, request, reply) => {
    const normalizedError = error instanceof Error ? error : new Error("Unknown agent error.");
    const mapped = mapError(normalizedError);
    database.audit(workspaceId, "http", `${request.method} ${request.routeOptions.url}`, "failed", {
      code: mapped.code,
    });
    void reply.code(mapped.status).send(errorBody(mapped.code, mapped.message, mapped.recoverable));
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

  try {
    await app.listen({ host: "127.0.0.1", port: options.port ?? (options.dev ? 4321 : 0) });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Unable to determine agent port.");
    const port = address.port;
    boundOrigin = `http://127.0.0.1:${port}`;
    allowedOrigins.add(boundOrigin);
    await indexer.start();

    let closed = false;
    return {
      app,
      workspaceId,
      capabilityToken,
      port,
      origin: boundOrigin,
      async close() {
        if (closed) return;
        closed = true;
        ask.close();
        codex.close();
        terminals.close();
        await indexer.close();
        events.close();
        await app.close();
        database.close();
        await lock.release();
      },
    };
  } catch (error) {
    ask.close();
    codex.close();
    terminals.close();
    await indexer.close();
    events.close();
    database.close();
    await lock.release();
    throw error;
  }
}

function hasCapability(request: FastifyRequest, token: string): boolean {
  const authorization = request.headers.authorization;
  return authorization === `Bearer ${token}`;
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

function mapError(error: Error): {
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
  if (error instanceof OpenAIUnavailableError || error instanceof CodexUnavailableError) {
    return { status: 503, code: error.code, message: error.message, recoverable: true };
  }
  const nodeError = error as NodeJS.ErrnoException;
  if (nodeError.code === "ENOENT") {
    return { status: 404, code: "NOT_FOUND", message: "Resource not found.", recoverable: true };
  }
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: redactSecrets(error.message || "Internal agent error."),
    recoverable: true,
  };
}

export function createWorkspaceId(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 24);
}

class WorkspaceLock {
  private constructor(
    private readonly path: string,
    private readonly handle: Awaited<ReturnType<typeof open>>,
  ) {}

  static async acquire(path: string): Promise<WorkspaceLock> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, "wx", 0o600);
        await handle.writeFile(String(process.pid));
        return new WorkspaceLock(path, handle);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let stale = false;
        try {
          const pid = Number.parseInt(await readFile(path, "utf8"), 10);
          if (!Number.isFinite(pid)) stale = true;
          else process.kill(pid, 0);
        } catch (checkError) {
          const code = (checkError as NodeJS.ErrnoException).code;
          stale = code === "ESRCH" || code === "ENOENT";
        }
        if (!stale) throw new Error("Constelix is already running for this workspace.");
        await unlink(path).catch(() => undefined);
      }
    }
    throw new Error("Unable to acquire the workspace lock.");
  }

  async release(): Promise<void> {
    await this.handle.close().catch(() => undefined);
    await unlink(this.path).catch(() => undefined);
  }
}
