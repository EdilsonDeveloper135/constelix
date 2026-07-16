import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startAgentServer } from "./server.js";

describe("local agent HTTP boundary", () => {
  it("requires a capability and reads workspace files", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-server-"));
    await writeFile(join(root, "main.ts"), "export const answer = 42;\n");
    const server = await startAgentServer({
      workspaceRoot: root,
      port: 0,
      capabilityToken: "test-capability",
      databasePath: join(root, "agent-test.sqlite"),
      webDistPath: join(root, "missing-web-dist"),
    });
    const host = new URL(server.origin).host;
    try {
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
          panels: [{ id: "file-node", position: { x: 10, y: 20 }, width: 300, hidden: false }],
        },
      });
      expect(layout.statusCode).toBe(200);

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
          capabilities: ["workspace-write", "commands", "network"],
          outsideWorkspace: "deny",
        },
      });
      expect(actTask.statusCode).toBe(201);
      expect(actTask.json()).toMatchObject({
        status: "pending_approval",
        scope: { networkEnabled: true, outsideWorkspaceWrites: false },
      });

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
          socket.send(JSON.stringify({ protocolVersion: 1, type: "auth", token: "test-capability" }));
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
      socket.close();

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
      const payload = bootstrap.json() as { graph: { nodes: Array<{ name: string }> } };
      expect(payload.graph.nodes.some((node) => node.name === "main.ts")).toBe(true);
    } finally {
      await server.close();
    }
  });
});
