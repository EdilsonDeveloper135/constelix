import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TESTED_CODEX_VERSION } from "./codex.js";
import { ConstelixDatabase } from "./database.js";
import { createWorkspaceId, startAgentServer } from "./server.js";

describe("local agent HTTP boundary", () => {
  it("opens a workspace in read mode without disabling local Ask", async () => {
    const parent = await mkdtemp(join(tmpdir(), "constelix-read-mode-"));
    const root = join(parent, "workspace");
    await mkdir(root);
    await writeFile(join(root, "main.ts"), "export function localSymbol() { return true; }\n");
    const server = await startAgentServer({
      workspaceRoot: root,
      readOnly: true,
      port: 0,
      capabilityToken: "read-mode-capability",
      storageDirectory: join(parent, "state"),
      databasePath: join(parent, "constelix.sqlite"),
      webDistPath: join(parent, "missing-web-dist"),
      askOptions: { apiKey: "" },
    });
    const headers = {
      host: new URL(server.origin).host,
      authorization: "Bearer read-mode-capability",
      "content-type": "application/json",
    };
    try {
      const bootstrap = await server.app.inject({
        method: "GET",
        url: "/api/v1/bootstrap",
        headers,
      });
      expect(bootstrap.statusCode).toBe(200);
      expect(bootstrap.json()).toMatchObject({
        workspace: {
          id: server.workspaceId,
          name: "workspace",
          mode: "read",
          readOnly: true,
        },
        capabilities: {
          ask: true,
          askMode: "local",
          act: false,
          terminal: true,
        },
      });
      expect(JSON.stringify(bootstrap.json())).not.toContain(root);

      const read = await server.app.inject({
        method: "POST",
        url: "/api/v1/files/read",
        headers,
        payload: { protocolVersion: 1, relativePath: "main.ts" },
      });
      const contentHash = (read.json() as { contentHash: string }).contentHash;
      const write = await server.app.inject({
        method: "PUT",
        url: "/api/v1/files/write",
        headers,
        payload: {
          protocolVersion: 1,
          relativePath: "main.ts",
          content: "export const changed = true;\n",
          expectedContentHash: contentHash,
        },
      });
      expect(write.statusCode).toBe(403);
      expect(write.json()).toMatchObject({
        error: { code: "WORKSPACE_READ_ONLY" },
      });

      const act = await server.app.inject({
        method: "POST",
        url: "/api/v1/act/tasks",
        headers,
        payload: {
          protocolVersion: 1,
          objective: "Change main.ts",
          capabilities: ["read", "write", "command"],
        },
      });
      expect(act.statusCode).toBe(403);
      expect(act.json()).toMatchObject({
        error: { code: "WORKSPACE_READ_ONLY" },
      });

      const ask = await server.app.inject({
        method: "POST",
        url: `/api/v1/ask/threads/${server.workspaceId}:main/turns`,
        headers,
        payload: {
          protocolVersion: 1,
          requestId: "read-mode-ask",
          threadId: `${server.workspaceId}:main`,
          prompt: "localSymbol",
          selectedNodeIds: [],
        },
      });
      expect(ask.statusCode).toBe(202);
    } finally {
      await server.close();
    }
  });

  it("rejects Constelix state paths inside the opened workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-state-containment-"));
    await writeFile(join(root, "main.ts"), "export const safe = true;\n");

    await expect(startAgentServer({
      workspaceRoot: root,
      port: 0,
      storageDirectory: join(root, ".constelix"),
      databasePath: join(root, ".constelix", "constelix.sqlite"),
      webDistPath: join(root, "missing-web-dist"),
    })).rejects.toThrow("storageDirectory debe estar fuera del workspace.");
  });

  it("updates per-workspace LLM settings without returning or auditing the secret", async () => {
    const parent = await mkdtemp(join(tmpdir(), "constelix-llm-route-"));
    const root = join(parent, "workspace");
    const storageDirectory = join(parent, "state");
    const databasePath = join(parent, "constelix.sqlite");
    const secret = "route-secret-must-remain-write-only";
    await mkdir(root);
    await writeFile(join(root, "main.ts"), "export const safe = true;\n");
    const server = await startAgentServer({
      workspaceRoot: root,
      readOnly: true,
      port: 0,
      capabilityToken: "llm-settings-capability",
      storageDirectory,
      databasePath,
      webDistPath: join(parent, "missing-web-dist"),
      askOptions: {
        apiKey: "",
        provider: {
          async stream() {
            return (async function* emptyStream() {})();
          },
        },
      },
    });
    const headers = {
      host: new URL(server.origin).host,
      authorization: "Bearer llm-settings-capability",
      "content-type": "application/json",
    };

    try {
      let indexPhase = "idle";
      for (let attempt = 0; attempt < 100 && indexPhase !== "ready"; attempt += 1) {
        const health = await server.app.inject({
          method: "GET",
          url: "/api/v1/health",
          headers,
        });
        indexPhase = (health.json() as { index: { phase: string } }).index.phase;
        if (indexPhase !== "ready") {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(indexPhase).toBe("ready");

      const initial = await server.app.inject({
        method: "GET",
        url: "/api/v1/settings/llm",
        headers,
      });
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toMatchObject({
        protocolVersion: 1,
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o",
      });
      expect(JSON.stringify(initial.json())).not.toContain("apiKey\"");

      const updated = await server.app.inject({
        method: "PUT",
        url: "/api/v1/settings/llm",
        headers,
        payload: {
          protocolVersion: 1,
          baseUrl: "https://compatible.example/v1",
          model: "compatible-model",
          apiKey: { action: "replace", value: secret },
        },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({
        baseUrl: "https://compatible.example/v1",
        model: "compatible-model",
        providerKind: "compatible",
        apiKeyConfigured: true,
        apiKeySource: "stored",
      });
      expect(JSON.stringify(updated.json())).not.toContain(secret);
      expect(JSON.stringify(updated.json())).not.toContain("\"apiKey\"");

      const bootstrap = await server.app.inject({
        method: "GET",
        url: "/api/v1/bootstrap",
        headers,
      });
      expect(bootstrap.statusCode).toBe(200);
      expect(bootstrap.json()).toMatchObject({
        capabilities: {
          model: "compatible-model",
          llm: {
            baseUrl: "https://compatible.example/v1",
            apiKeyConfigured: true,
          },
        },
      });
      expect(JSON.stringify(bootstrap.json())).not.toContain(secret);
      const storedSecret = JSON.parse(
        await readFile(join(storageDirectory, "llm-api-key"), "utf8"),
      ) as { apiKey: string; baseUrl: string };
      expect(storedSecret).toMatchObject({
        apiKey: secret,
        baseUrl: "https://compatible.example/v1",
      });
      expect(await readFile(join(storageDirectory, "llm-settings.json"), "utf8")).not.toContain(secret);
      expect((await readFile(databasePath)).toString("utf8")).not.toContain(secret);

      const unsafe = await server.app.inject({
        method: "PUT",
        url: "/api/v1/settings/llm",
        headers,
        payload: {
          protocolVersion: 1,
          baseUrl: "http://remote.example/v1",
          model: "unsafe-model",
          apiKey: { action: "preserve" },
        },
      });
      expect(unsafe.statusCode).toBe(400);
      expect(unsafe.json()).toMatchObject({
        error: { code: "LLM_CONFIGURATION_INVALID" },
      });

      const local = await server.app.inject({
        method: "PUT",
        url: "/api/v1/settings/llm",
        headers,
        payload: {
          protocolVersion: 1,
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "qwen2.5-coder:7b",
          apiKey: { action: "clear" },
        },
      });
      expect(local.statusCode).toBe(200);
      expect(local.json()).toMatchObject({
        providerKind: "ollama",
        apiKeyConfigured: false,
        apiKeyRequired: false,
      });
    } finally {
      await server.close();
    }
  });

  it("returns bootstrap while Codex compatibility is still being checked", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-codex-bootstrap-"));
    const stateRoot = await mkdtemp(join(tmpdir(), "constelix-codex-state-"));
    await writeFile(join(root, "main.ts"), "export const ready = true;\n");
    let resolveVersion: ((version: string) => void) | undefined;
    const version = new Promise<string>((resolve) => {
      resolveVersion = resolve;
    });
    const server = await startAgentServer({
      workspaceRoot: root,
      port: 0,
      capabilityToken: "codex-bootstrap-capability",
      storageDirectory: join(stateRoot, "state"),
      databasePath: join(stateRoot, "agent-test.sqlite"),
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
    const stateRoot = await mkdtemp(join(tmpdir(), "constelix-server-state-"));
    await writeFile(join(root, "main.ts"), "export const answer = 42;\n");
    const server = await startAgentServer({
      workspaceRoot: root,
      port: 0,
      capabilityToken: "test-capability",
      storageDirectory: join(stateRoot, "state"),
      databasePath: join(stateRoot, "agent-test.sqlite"),
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
      expect(actTask.json()).not.toHaveProperty("workspaceRoot");
      expect(JSON.stringify(actTask.json())).not.toContain(root);
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
      expect(bootstrapWithActiveTask.json().activeActTask).not.toHaveProperty(
        "workspaceRoot",
      );
      expect(
        JSON.stringify(bootstrapWithActiveTask.json().activeActTask),
      ).not.toContain(root);

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

      let resolveReady: (() => void) | undefined;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        const timeout = setTimeout(() => reject(new Error("WebSocket authentication timed out.")), 2_000);
        resolveReady = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
      const socket = await server.app.injectWS(
        "/api/v1/events?token=test-capability",
        { headers: { host, origin: server.origin } },
        {
          onInit: (candidate) => {
            candidate.on("message", (raw: Buffer) => {
              const message = JSON.parse(raw.toString()) as { type?: string };
              if (message.type === "connection.ready") resolveReady?.();
            });
          },
        },
      );
      await ready;

      const invalidMessage = new Promise<{ type?: string; payload?: { code?: string } }>(
        (resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Invalid WebSocket message was not rejected.")),
            2_000,
          );
          socket.on("message", (raw: Buffer) => {
            const message = JSON.parse(raw.toString()) as {
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

      await expect(server.app.injectWS(
        "/api/v1/events",
        { headers: { host, origin: server.origin } },
      )).rejects.toThrow("Unexpected server response: 401");
      await expect(server.app.injectWS(
        "/api/v1/events?token=incorrect-capability",
        { headers: { host, origin: server.origin } },
      )).rejects.toThrow("Unexpected server response: 401");
      await expect(server.app.injectWS(
        "/api/v1/events?token=test-capability&token=test-capability",
        { headers: { host, origin: server.origin } },
      )).rejects.toThrow("Unexpected server response: 401");
      await expect(server.app.injectWS(
        "/api/v1/events?token=test-capability",
        { headers: { host, origin: "https://attacker.invalid" } },
      )).rejects.toThrow("Unexpected server response: 403");
      await expect(server.app.injectWS(
        "/api/v1/events?token=test-capability",
        { headers: { host: "attacker.invalid", origin: server.origin } },
      )).rejects.toThrow("Unexpected server response: 403");

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
      ).rejects.toThrow("El workspace ya está abierto por otra instancia de Constelix.");

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
