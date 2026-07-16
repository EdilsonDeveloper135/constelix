import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TESTED_CODEX_VERSION } from "./codex.js";
import { ConstelixDatabase } from "./database.js";
import { createWorkspaceId, startAgentServer } from "./server.js";

describe("local agent HTTP boundary", () => {
  it("returns bootstrap while Codex compatibility is still being checked", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-codex-bootstrap-"));
    await writeFile(join(root, "main.ts"), "export const ready = true;\n");
    let resolveVersion: ((version: string) => void) | undefined;
    const version = new Promise<string>((resolve) => {
      resolveVersion = resolve;
    });
    const server = await startAgentServer({
      workspaceRoot: root,
      port: 0,
      capabilityToken: "codex-bootstrap-capability",
      storageDirectory: join(root, ".constelix-test-state"),
      databasePath: join(root, "agent-test.sqlite"),
      webDistPath: join(root, "missing-web-dist"),
      codexOptions: {
        getCodexVersion: async () => version,
      },
    });
    try {
      const headers = {
        host: new URL(server.origin).host,
        authorization: "Bearer codex-bootstrap-capability",
      };
      const first = await Promise.race([
        server.app.inject({
          method: "GET",
          url: "/api/v1/bootstrap",
          headers,
        }),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("Bootstrap waited for Codex availability.")),
            250,
          ).unref();
        }),
      ]);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        capabilities: {
          act: false,
          codexChecking: true,
        },
      });

      resolveVersion?.(TESTED_CODEX_VERSION);
      let resolved: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const response = await server.app.inject({
          method: "GET",
          url: "/api/v1/bootstrap",
          headers,
        });
        const payload = response.json() as {
          capabilities: Record<string, unknown>;
        };
        if (payload.capabilities.act === true) {
          resolved = payload.capabilities;
          break;
        }
      }
      expect(resolved).toMatchObject({
        act: true,
        codexChecking: false,
        codexVersion: TESTED_CODEX_VERSION,
      });
    } finally {
      resolveVersion?.(TESTED_CODEX_VERSION);
      await server.close();
    }
  });

  it("requires a capability and reads workspace files", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-server-"));
    await writeFile(join(root, "main.ts"), "export const answer = 42;\n");
    const server = await startAgentServer({
      workspaceRoot: root,
      port: 0,
      capabilityToken: "test-capability",
      storageDirectory: join(root, ".constelix-test-state"),
      databasePath: join(root, "agent-test.sqlite"),
      webDistPath: join(root, "missing-web-dist"),
    });
    const host = new URL(server.origin).host;
    try {
      const invalidHost = await server.app.inject({
        method: "GET",
        url: "/api/v1/health",
        headers: {
          host: "attacker.invalid",
          authorization: "Bearer test-capability",
        },
      });
      expect(invalidHost.statusCode).toBe(403);
      expect(invalidHost.json()).toMatchObject({
        error: { code: "INVALID_HOST" },
      });

      const invalidOrigin = await server.app.inject({
        method: "GET",
        url: "/api/v1/health",
        headers: {
          host,
          origin: "https://attacker.invalid",
          authorization: "Bearer test-capability",
        },
      });
      expect(invalidOrigin.statusCode).toBe(403);
      expect(invalidOrigin.json()).toMatchObject({
        error: { code: "INVALID_ORIGIN" },
      });

      const unauthorized = await server.app.inject({
        method: "GET",
        url: "/api/v1/health",
        headers: { host },
      });
      expect(unauthorized.statusCode).toBe(401);

      const authorized = await server.app.inject({
        method: "GET",
        url: "/api/v1/health",
        headers: { host, authorization: "Bearer test-capability" },
      });
      expect(authorized.statusCode).toBe(200);
      expect(authorized.json()).toMatchObject({ protocolVersion: 1, status: "ok" });

      const read = await server.app.inject({
        method: "POST",
        url: "/api/v1/files/read",
        headers: {
          host,
          authorization: "Bearer test-capability",
          "content-type": "application/json",
        },
        payload: { protocolVersion: 1, relativePath: "main.ts" },
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({
        relativePath: "main.ts",
        content: "export const answer = 42;\n",
        language: "typescript",
      });
      const opened = read.json() as { contentHash: string };

      const write = await server.app.inject({
        method: "PUT",
        url: "/api/v1/files/write",
        headers: {
          host,
          authorization: "Bearer test-capability",
          "content-type": "application/json",
        },
        payload: {
          protocolVersion: 1,
          relativePath: "main.ts",
          content: "export const answer = 43;\n",
          expectedContentHash: opened.contentHash,
        },
      });
      expect(write.statusCode).toBe(200);

      const conflict = await server.app.inject({
        method: "PUT",
        url: "/api/v1/files/write",
        headers: {
          host,
          authorization: "Bearer test-capability",
          "content-type": "application/json",
        },
        payload: {
          protocolVersion: 1,
          relativePath: "main.ts",
          content: "stale\n",
          expectedContentHash: opened.contentHash,
        },
      });
      expect(conflict.statusCode).toBe(409);

      const traversal = await server.app.inject({
        method: "POST",
        url: "/api/v1/files/read",
        headers: {
          host,
          authorization: "Bearer test-capability",
          "content-type": "application/json",
        },
        payload: { protocolVersion: 1, relativePath: "../secret" },
      });
      expect(traversal.statusCode).toBe(403);

      const layout = await server.app.inject({
        method: "PUT",
        url: "/api/v1/layout",
        headers: {
          host,
          authorization: "Bearer test-capability",
          "content-type": "application/json",
        },
        payload: {
          protocolVersion: 1,
          panels: [{
            protocolVersion: 1,
            id: "file-node",
            kind: "index",
            position: { x: 10, y: 20 },
            size: { width: 300, height: 180 },
            resource: { semantic: true },
            zoom: 1,
            pinned: false,
            updatedAt: "2026-07-16T00:00:00.000Z",
          }],
        },
      });
      expect(layout.statusCode).toBe(200);
      const invalidLayout = await server.app.inject({
        method: "PUT",
        url: "/api/v1/layout",
        headers: {
          host,
          authorization: "Bearer test-capability",
          "content-type": "application/json",
        },
        payload: {
          protocolVersion: 1,
          panels: [{ id: "legacy-panel", position: { x: 0, y: 0 } }],
        },
      });
      expect(invalidLayout.statusCode).toBe(400);

      const unsupportedActScope = await server.app.inject({
        method: "POST",
        url: "/api/v1/act/tasks",
        headers: {
          host,
          authorization: "Bearer test-capability",
          "content-type": "application/json",
        },
        payload: {
          protocolVersion: 1,
          objective: "Inspect the project.",
          capabilities: ["read"],
        },
      });
      expect(unsupportedActScope.statusCode).toBe(400);
      expect(unsupportedActScope.json()).toMatchObject({
        error: { code: "UNSUPPORTED_ACT_SCOPE" },
      });

      const actTask = await server.app.inject({
        method: "POST",
        url: "/api/v1/act/tasks",
        headers: {
          host,
          authorization: "Bearer test-capability",
          "content-type": "application/json",
        },
        payload: {
          protocolVersion: 1,
          objective: "Inspect the project without approving the turn.",
          capabilities: ["read", "write", "command"],
        },
      });
      expect(actTask.statusCode).toBe(201);
      expect(actTask.json()).toMatchObject({
        status: "pending_approval",
        scope: { networkEnabled: true, outsideWorkspaceWrites: false },
      });
      const actTaskId = (actTask.json() as { id: string }).id;
      const bootstrapWithActiveTask = await server.app.inject({
        method: "GET",
        url: "/api/v1/bootstrap",
        headers: {
          host,
          authorization: "Bearer test-capability",
        },
      });
      expect(bootstrapWithActiveTask.statusCode).toBe(200);
      expect(bootstrapWithActiveTask.json()).toMatchObject({
        activeActTask: {
          protocolVersion: 1,
          id: actTaskId,
          status: "pending_approval",
          scope: {
            objective: "Inspect the project without approving the turn.",
          },
        },
      });

      const approvalWithoutConsent = await server.app.inject({
        method: "POST",
        url: `/api/v1/act/tasks/${actTaskId}/approve`,
        headers: {
          host,
          authorization: "Bearer test-capability",
          "content-type": "application/json",
        },
        payload: { protocolVersion: 1, taskId: actTaskId },
      });
      expect(approvalWithoutConsent.statusCode).toBe(400);

      const invalidCancellation = await server.app.inject({
        method: "POST",
        url: `/api/v1/act/tasks/${actTaskId}/cancel`,
        headers: {
          host,
          authorization: "Bearer test-capability",
          "content-type": "application/json",
        },
        payload: {},
      });
      expect(invalidCancellation.statusCode).toBe(400);

      const cancellation = await server.app.inject({
        method: "POST",
        url: `/api/v1/act/tasks/${actTaskId}/cancel`,
        headers: {
          host,
          authorization: "Bearer test-capability",
          "content-type": "application/json",
        },
        payload: { protocolVersion: 1 },
      });
      expect(cancellation.statusCode).toBe(200);
      expect(cancellation.json()).toMatchObject({ status: "cancelled" });

      const terminal = await server.app.inject({
        method: "POST",
        url: "/api/v1/terminals",
        headers: {
          host,
          authorization: "Bearer test-capability",
          "content-type": "application/json",
        },
        payload: { protocolVersion: 1, cwd: ".", columns: 80, rows: 24 },
      });
      expect(terminal.statusCode).toBe(201);
      const terminalId = (terminal.json() as { id: string }).id;
      let terminalOutput:
        | {
            chunks: Array<{ sequence: number; data: string }>;
            latestSequence: number;
            truncated: boolean;
          }
        | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const output = await server.app.inject({
          method: "GET",
          url: `/api/v1/terminals/${terminalId}/output?after=0`,
          headers: { host, authorization: "Bearer test-capability" },
        });
        expect(output.statusCode).toBe(200);
        terminalOutput = output.json() as typeof terminalOutput;
        if (terminalOutput?.chunks.length) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(terminalOutput).toMatchObject({
        truncated: false,
      });
      expect(terminalOutput?.chunks.length).toBeGreaterThan(0);
      expect(terminalOutput?.chunks.at(-1)?.sequence).toBe(terminalOutput?.latestSequence);

      const removedTerminal = await server.app.inject({
        method: "DELETE",
        url: `/api/v1/terminals/${terminalId}`,
        headers: { host, authorization: "Bearer test-capability" },
      });
      expect(removedTerminal.statusCode).toBe(204);

      const socket = new WebSocket(`${server.origin.replace("http", "ws")}/api/v1/events`);
      const ready = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("WebSocket authentication timed out.")), 2_000);
        socket.addEventListener("open", () => {
          socket.send(JSON.stringify({
            protocolVersion: 1,
            type: "authenticate",
            token: "test-capability",
          }));
        });
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data)) as { type?: string };
          if (message.type === "connection.ready") {
            clearTimeout(timeout);
            resolve();
          }
        });
        socket.addEventListener("error", () => reject(new Error("WebSocket connection failed.")));
      });
      await ready;

      const invalidMessage = new Promise<{ type?: string; payload?: { code?: string } }>(
        (resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Invalid WebSocket message was not rejected.")),
            2_000,
          );
          socket.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data)) as {
              type?: string;
              payload?: { code?: string };
            };
            if (message.type !== "error") return;
            clearTimeout(timeout);
            resolve(message);
          });
        },
      );
      socket.send(JSON.stringify({
        protocolVersion: 2,
        type: "terminal.resize",
        terminalId,
        cols: 80,
        rows: 24,
      }));
      await expect(invalidMessage).resolves.toMatchObject({
        type: "error",
        payload: { code: "INVALID_MESSAGE" },
      });
      socket.close();

      const unauthenticatedSocket = new WebSocket(
        `${server.origin.replace("http", "ws")}/api/v1/events`,
      );
      const unauthenticatedClose = new Promise<CloseEvent>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Unauthenticated WebSocket was not closed.")),
          3_000,
        );
        unauthenticatedSocket.addEventListener("close", (event) => {
          clearTimeout(timeout);
          resolve(event);
        });
        unauthenticatedSocket.addEventListener("error", () => {
          // A close event with the protocol code remains the source of truth.
        });
      });
      const closeEvent = await unauthenticatedClose;
      expect(closeEvent.code).toBe(4401);

      let indexPhase = "idle";
      for (let attempt = 0; attempt < 100 && indexPhase !== "ready"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const health = await server.app.inject({
          method: "GET",
          url: "/api/v1/health",
          headers: { host, authorization: "Bearer test-capability" },
        });
        indexPhase = (health.json() as { index: { phase: string } }).index.phase;
      }
      expect(indexPhase).toBe("ready");

      const bootstrap = await server.app.inject({
        method: "GET",
        url: "/api/v1/bootstrap",
        headers: { host, authorization: "Bearer test-capability" },
      });
      expect(bootstrap.statusCode).toBe(200);
      const payload = bootstrap.json() as {
        activeAskTurnIds: string[];
        graph: { nodes: Array<{ name: string }>; edges: unknown[] };
        index: { symbolsIndexed: number; edgesIndexed: number };
      };
      expect(payload.graph.nodes.some((node) => node.name === "main.ts")).toBe(true);
      expect(payload.activeAskTurnIds).toEqual([]);
      expect(payload.index.symbolsIndexed).toBeGreaterThanOrEqual(payload.graph.nodes.length);
      expect(payload.index.edgesIndexed).toBeGreaterThanOrEqual(payload.graph.edges.length);
    } finally {
      await server.close();
    }
  }, 15_000);

  it("restores file-backed layout and conversations after an agent restart", async () => {
    const parent = await mkdtemp(join(tmpdir(), "constelix-restart-"));
    const root = join(parent, "workspace");
    await mkdir(root);
    await writeFile(join(root, "main.ts"), "export const persisted = true;\n");
    const databasePath = join(parent, "constelix.sqlite");
    const storageDirectory = join(parent, "state");
    const workspaceId = createWorkspaceId(root);
    const seed = new ConstelixDatabase(databasePath);
    seed.upsertWorkspace(workspaceId, root);
    seed.appendAiMessage(workspaceId, `${workspaceId}:main`, {
      id: "question",
      role: "user",
      content: "¿Dónde se define persisted?",
    });
    seed.appendAiMessage(workspaceId, `${workspaceId}:main`, {
      id: "answer",
      role: "assistant",
      content: "Se define en main.ts.",
    });
    seed.close();

    const first = await startAgentServer({
      workspaceRoot: root,
      port: 0,
      capabilityToken: "restart-capability",
      storageDirectory,
      databasePath,
      webDistPath: join(parent, "missing-web-dist"),
    });
    const firstHost = new URL(first.origin).host;
    const panel = {
      protocolVersion: 1,
      id: "panel-editor",
      kind: "editor",
      position: { x: 123, y: 234 },
      size: { width: 640, height: 420 },
      resource: { relativePath: "main.ts", hidden: false },
      zoom: 1,
      pinned: true,
      updatedAt: "2026-07-16T00:00:00.000Z",
    };
    try {
      await expect(
        startAgentServer({
          workspaceRoot: root,
          port: 0,
          capabilityToken: "second-capability",
          storageDirectory,
          databasePath,
          webDistPath: join(parent, "missing-web-dist"),
        }),
      ).rejects.toThrow(/already running/i);

      const saved = await first.app.inject({
        method: "PUT",
        url: "/api/v1/layout",
        headers: {
          host: firstHost,
          authorization: "Bearer restart-capability",
          "content-type": "application/json",
        },
        payload: { protocolVersion: 1, panels: [panel] },
      });
      expect(saved.statusCode).toBe(200);
    } finally {
      await first.close();
    }

    const second = await startAgentServer({
      workspaceRoot: root,
      port: 0,
      capabilityToken: "restart-capability",
      storageDirectory,
      databasePath,
      webDistPath: join(parent, "missing-web-dist"),
    });
    try {
      const bootstrap = await second.app.inject({
        method: "GET",
        url: "/api/v1/bootstrap",
        headers: {
          host: new URL(second.origin).host,
          authorization: "Bearer restart-capability",
        },
      });
      expect(bootstrap.statusCode).toBe(200);
      expect(bootstrap.json()).toMatchObject({
        layout: [panel],
        conversation: [
          { role: "user", content: "¿Dónde se define persisted?" },
          { role: "assistant", content: "Se define en main.ts." },
        ],
      });
    } finally {
      await second.close();
    }
  });

  it("releases the workspace lock and resources when startup fails after acquisition", async () => {
    const parent = await mkdtemp(join(tmpdir(), "constelix-startup-cleanup-"));
    const occupiedRoot = join(parent, "occupied");
    const retryRoot = join(parent, "retry");
    await mkdir(occupiedRoot);
    await mkdir(retryRoot);
    await writeFile(join(occupiedRoot, "main.ts"), "export const occupied = true;\n");
    await writeFile(join(retryRoot, "main.ts"), "export const retry = true;\n");

    const occupied = await startAgentServer({
      workspaceRoot: occupiedRoot,
      port: 0,
      capabilityToken: "occupied-capability",
      storageDirectory: join(parent, "occupied-state"),
      databasePath: join(parent, "occupied.sqlite"),
      webDistPath: join(parent, "missing-web-dist"),
    });
    const retryStorage = join(parent, "retry-state");
    const retryDatabase = join(parent, "retry.sqlite");
    try {
      await expect(
        startAgentServer({
          workspaceRoot: retryRoot,
          port: occupied.port,
          capabilityToken: "retry-capability",
          storageDirectory: retryStorage,
          databasePath: retryDatabase,
          webDistPath: join(parent, "missing-web-dist"),
        }),
      ).rejects.toThrow();
    } finally {
      await occupied.close();
    }

    const retried = await startAgentServer({
      workspaceRoot: retryRoot,
      port: occupied.port,
      capabilityToken: "retry-capability",
      storageDirectory: retryStorage,
      databasePath: retryDatabase,
      webDistPath: join(parent, "missing-web-dist"),
    });
    await expect(Promise.all([retried.close(), retried.close()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });
});
