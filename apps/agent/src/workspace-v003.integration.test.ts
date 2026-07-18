import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TESTED_CODEX_VERSION } from "./codex.js";
import { inspectWorkspace } from "./security.js";
import {
  type RunningAgentServer,
  startAgentServer,
} from "./server.js";

const TYPESCRIPT_FIXTURE = fileURLToPath(
  new URL("../../../tests/fixtures/v003-typescript-workspace/", import.meta.url),
);
const MONOREPO_FIXTURE = fileURLToPath(
  new URL("../../../tests/fixtures/v003-monorepo-workspace/", import.meta.url),
);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("Constelix v0.0.3 workspace integration", () => {
  it("indexes deterministic TypeScript and JS/TS/Python workspaces without following an external symlink", async () => {
    const parent = await temporaryDirectory("constelix-v003-fixtures-");
    const typescriptRoot = join(parent, "typescript-workspace");
    const monorepoRoot = join(parent, "monorepo-workspace");
    const outside = join(parent, "outside");
    const stateRoot = join(parent, "state");
    await Promise.all([
      cp(TYPESCRIPT_FIXTURE, typescriptRoot, { recursive: true }),
      cp(MONOREPO_FIXTURE, monorepoRoot, { recursive: true }),
      mkdir(outside),
      mkdir(stateRoot),
    ]);
    await writeFile(join(outside, "secret.ts"), "export const leaked = true;\n");
    await symlink(outside, join(typescriptRoot, "external-link"));

    const typescriptServer = await createServer(
      typescriptRoot,
      join(stateRoot, "typescript"),
      join(stateRoot, "typescript.sqlite"),
      "typescript-capability",
    );
    try {
      const bootstrap = await waitForReady(typescriptServer);
      expect(bootstrap.summary).toMatchObject({
        projectTypes: ["Node.js", "TypeScript"],
        languages: ["typescript"],
        indexedFileCount: 2,
      });
      expect(pathsFromBootstrap(bootstrap)).toEqual(
        expect.arrayContaining(["src/greeting.ts", "src/index.ts"]),
      );
      expect(JSON.stringify(bootstrap)).not.toContain(typescriptRoot);
      expect(JSON.stringify(bootstrap)).not.toContain("secret.ts");

      const escapedRead = await typescriptServer.app.inject({
        method: "POST",
        url: "/api/v1/files/read",
        headers: headers(typescriptServer),
        payload: {
          protocolVersion: 1,
          relativePath: "external-link/secret.ts",
        },
      });
      expect(escapedRead.statusCode).toBe(403);
      expect(escapedRead.json()).toMatchObject({
        error: { code: "PATH_OUTSIDE_WORKSPACE" },
      });
      expect(isOutside(typescriptRoot, join(stateRoot, "typescript"))).toBe(true);
      await expect(access(join(typescriptRoot, ".constelix"))).rejects.toThrow();
    } finally {
      await typescriptServer.close();
    }

    const monorepoServer = await createServer(
      monorepoRoot,
      join(stateRoot, "monorepo"),
      join(stateRoot, "monorepo.sqlite"),
      "monorepo-capability",
    );
    try {
      const bootstrap = await waitForReady(monorepoServer);
      expect(bootstrap.summary.projectTypes).toEqual(
        expect.arrayContaining(["Node.js", "Python", "pnpm workspace"]),
      );
      expect(bootstrap.summary.languages).toEqual(
        expect.arrayContaining(["javascript", "typescript", "python"]),
      );
      expect(pathsFromBootstrap(bootstrap)).toEqual(
        expect.arrayContaining([
          "apps/dashboard/src/index.ts",
          "packages/shared/src/math.js",
          "services/api/app.py",
        ]),
      );
    } finally {
      await monorepoServer.close();
    }
  });

  it("maps a canonical directory and its symlink alias to one workspace id and lock", async () => {
    const parent = await temporaryDirectory("constelix-v003-alias-");
    const root = join(parent, "workspace");
    const alias = join(parent, "workspace-alias");
    const state = join(parent, "state");
    await cp(TYPESCRIPT_FIXTURE, root, { recursive: true });
    await symlink(root, alias);

    const directDescriptor = await inspectWorkspace(root);
    const aliasDescriptor = await inspectWorkspace(alias);
    expect(aliasDescriptor.workspaceId).toBe(directDescriptor.workspaceId);
    expect(aliasDescriptor.canonicalRoot).toBe(await realpath(root));

    const first = await createServer(
      root,
      state,
      join(parent, "agent.sqlite"),
      "alias-direct-capability",
    );
    try {
      await expect(
        createServer(
          alias,
          state,
          join(parent, "alias.sqlite"),
          "alias-linked-capability",
        ),
      ).rejects.toThrow(
        "El workspace ya está abierto por otra instancia de Constelix.",
      );
    } finally {
      await first.close();
    }

    const reopened = await createServer(
      alias,
      state,
      join(parent, "reopened.sqlite"),
      "alias-reopened-capability",
    );
    try {
      expect(reopened.workspaceId).toBe(directDescriptor.workspaceId);
    } finally {
      await reopened.close();
    }
  });

  it("isolates graph, layout, chat, terminal, and Act state for workspaces with identical relative paths", async () => {
    const parent = await temporaryDirectory("constelix-v003-isolation-");
    const rootA = join(parent, "workspace-a");
    const rootB = join(parent, "workspace-b");
    const sharedDatabase = join(parent, "state", "shared.sqlite");
    await Promise.all([
      mkdir(join(rootA, "src"), { recursive: true }),
      mkdir(join(rootB, "src"), { recursive: true }),
      mkdir(dirname(sharedDatabase), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(rootA, "src", "index.ts"),
        "export function alphaOnly(): string { return 'workspace-a'; }\n",
      ),
      writeFile(
        join(rootB, "src", "index.ts"),
        "export function betaOnly(): string { return 'workspace-b'; }\n",
      ),
    ]);

    const serverA = await createServer(
      rootA,
      join(parent, "state", "a"),
      sharedDatabase,
      "workspace-a-capability",
    );
    const serverB = await createServer(
      rootB,
      join(parent, "state", "b"),
      sharedDatabase,
      "workspace-b-capability",
    );
    try {
      const [initialA, initialB] = await Promise.all([
        waitForReady(serverA),
        waitForReady(serverB),
      ]);
      expect(JSON.stringify(initialA.graph)).toContain("alphaOnly");
      expect(JSON.stringify(initialA.graph)).not.toContain("betaOnly");
      expect(JSON.stringify(initialB.graph)).toContain("betaOnly");
      expect(JSON.stringify(initialB.graph)).not.toContain("alphaOnly");

      const layoutWrite = await serverA.app.inject({
        method: "PUT",
        url: "/api/v1/layout",
        headers: headers(serverA),
        payload: {
          protocolVersion: 1,
          revision: 1,
          panels: [{
            protocolVersion: 1,
            id: "workspace-a-editor",
            kind: "editor",
            position: { x: 20, y: 30 },
            size: { width: 640, height: 420 },
            resource: { relativePath: "src/index.ts" },
            zoom: 1,
            pinned: true,
            updatedAt: "2026-07-16T12:00:00.000Z",
          }],
        },
      });
      expect(layoutWrite.statusCode).toBe(200);

      const ask = await serverA.app.inject({
        method: "POST",
        url: `/api/v1/ask/threads/${serverA.workspaceId}:main/turns`,
        headers: headers(serverA),
        payload: {
          protocolVersion: 1,
          requestId: "workspace-a-local-ask",
          threadId: `${serverA.workspaceId}:main`,
          prompt: "alphaOnly",
          selectedNodeIds: [],
        },
      });
      expect(ask.statusCode).toBe(202);
      const completedA = await waitForBootstrap(
        serverA,
        (bootstrap) => bootstrap.conversation.length >= 2,
      );
      expect(completedA.conversation).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "alphaOnly" }),
          expect.objectContaining({ role: "assistant", mode: "local" }),
        ]),
      );

      const terminal = await serverA.app.inject({
        method: "POST",
        url: "/api/v1/terminals",
        headers: headers(serverA),
        payload: {
          protocolVersion: 1,
          cwd: ".",
          columns: 80,
          rows: 24,
          shell: "/bin/sh",
          panelId: "workspace-a-terminal",
        },
      });
      expect(terminal.statusCode).toBe(201);

      const act = await serverA.app.inject({
        method: "POST",
        url: "/api/v1/act/tasks",
        headers: headers(serverA),
        payload: {
          protocolVersion: 1,
          objective: "Inspect workspace A without approval.",
          capabilities: ["read", "write", "command"],
        },
      });
      expect(act.statusCode).toBe(201);

      const bootstrapB = await bootstrap(serverB);
      expect(bootstrapB.layout).toEqual([]);
      expect(bootstrapB.conversation).toEqual([]);
      expect(bootstrapB.terminals).toEqual([]);
      expect(bootstrapB.activeActTask).toBeNull();

      const foreignThread = await serverB.app.inject({
        method: "POST",
        url: `/api/v1/ask/threads/${serverA.workspaceId}:main/turns`,
        headers: headers(serverB),
        payload: {
          protocolVersion: 1,
          requestId: "foreign-thread-attempt",
          threadId: `${serverA.workspaceId}:main`,
          prompt: "betaOnly",
          selectedNodeIds: [],
        },
      });
      expect(foreignThread.statusCode).toBe(403);
      expect(foreignThread.json()).toMatchObject({
        error: { code: "THREAD_WORKSPACE_MISMATCH" },
      });
    } finally {
      await Promise.all([serverA.close(), serverB.close()]);
    }
  });

  it.skipIf(process.platform !== "darwin")(
    "blocks editor and Act writes while the read-only PTY sandbox cannot create a file",
    async () => {
      const parent = await temporaryDirectory("constelix-v003-read-only-");
      const root = join(parent, "workspace");
      const state = join(parent, "state");
      const probeShell = join(parent, "read-only-probe");
      const attemptedFile = join(root, "pty-write-attempt.txt");
      await cp(TYPESCRIPT_FIXTURE, root, { recursive: true });
      await writeFile(
        probeShell,
        [
          "#!/bin/sh",
          'touch "$CONSTELIX_WORKSPACE/pty-write-attempt.txt"',
          'printf "constelix-read-only-probe-complete\\n"',
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      await chmod(probeShell, 0o755);

      const server = await startAgentServer({
        workspaceRoot: root,
        readOnly: true,
        port: 0,
        capabilityToken: "read-only-capability",
        storageDirectory: state,
        databasePath: join(parent, "read-only.sqlite"),
        webDistPath: join(parent, "missing-web-dist"),
        askOptions: { apiKey: "" },
        codexOptions: {
          getCodexVersion: async () => TESTED_CODEX_VERSION,
        },
      });
      try {
        await waitForReady(server);
        const fileRead = await server.app.inject({
          method: "POST",
          url: "/api/v1/files/read",
          headers: headers(server),
          payload: {
            protocolVersion: 1,
            relativePath: "src/index.ts",
          },
        });
        expect(fileRead.statusCode).toBe(200);
        const write = await server.app.inject({
          method: "PUT",
          url: "/api/v1/files/write",
          headers: headers(server),
          payload: {
            protocolVersion: 1,
            relativePath: "src/index.ts",
            content: "export const forbidden = true;\n",
            expectedContentHash: fileRead.json().contentHash,
          },
        });
        expect(write.statusCode).toBe(403);
        expect(write.json()).toMatchObject({
          error: { code: "WORKSPACE_READ_ONLY" },
        });

        const act = await server.app.inject({
          method: "POST",
          url: "/api/v1/act/tasks",
          headers: headers(server),
          payload: {
            protocolVersion: 1,
            objective: "Create a forbidden file.",
            capabilities: ["read", "write", "command"],
          },
        });
        expect(act.statusCode).toBe(403);
        expect(act.json()).toMatchObject({
          error: { code: "WORKSPACE_READ_ONLY" },
        });

        const terminal = await server.app.inject({
          method: "POST",
          url: "/api/v1/terminals",
          headers: headers(server),
          payload: {
            protocolVersion: 1,
            cwd: ".",
            columns: 80,
            rows: 24,
            shell: probeShell,
            panelId: "read-only-probe-terminal",
          },
        });
        expect(terminal.statusCode).toBe(201);
        const terminalId = (terminal.json() as { id: string }).id;
        await waitUntil(async () => {
          const output = await server.app.inject({
            method: "GET",
            url: `/api/v1/terminals/${terminalId}/output?after=0`,
            headers: headers(server, false),
          });
          return output.body.includes("constelix-read-only-probe-complete");
        });
        await expect(access(attemptedFile)).rejects.toThrow();
        expect(isOutside(root, state)).toBe(true);
      } finally {
        await server.close();
      }
    },
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(path);
  return path;
}

async function createServer(
  workspaceRoot: string,
  storageDirectory: string,
  databasePath: string,
  capabilityToken: string,
): Promise<RunningAgentServer> {
  return startAgentServer({
    workspaceRoot,
    port: 0,
    capabilityToken,
    storageDirectory,
    databasePath,
    webDistPath: join(dirname(storageDirectory), "missing-web-dist"),
    askOptions: { apiKey: "" },
    codexOptions: {
      getCodexVersion: async () => TESTED_CODEX_VERSION,
    },
  });
}

function headers(
  server: RunningAgentServer,
  json = true,
): Record<string, string> {
  return {
    host: new URL(server.origin).host,
    authorization: `Bearer ${server.capabilityToken}`,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

async function waitForReady(
  server: RunningAgentServer,
): Promise<BootstrapPayload> {
  return waitForBootstrap(
    server,
    (payload) => payload.index.phase === "ready",
  );
}

async function waitForBootstrap(
  server: RunningAgentServer,
  predicate: (payload: BootstrapPayload) => boolean,
): Promise<BootstrapPayload> {
  let latest: BootstrapPayload | undefined;
  await waitUntil(async () => {
    latest = await bootstrap(server);
    return predicate(latest);
  });
  if (!latest) throw new Error("Bootstrap polling did not produce a payload.");
  return latest;
}

async function bootstrap(
  server: RunningAgentServer,
): Promise<BootstrapPayload> {
  const response = await server.app.inject({
    method: "GET",
    url: "/api/v1/bootstrap",
    headers: headers(server, false),
  });
  expect(response.statusCode).toBe(200);
  return response.json() as BootstrapPayload;
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Condition was not met within ${timeoutMs} ms.`);
}

function pathsFromBootstrap(payload: BootstrapPayload): string[] {
  return payload.graph.nodes
    .map((node) => node.relativePath)
    .filter((path): path is string => typeof path === "string");
}

function isOutside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === ".." || path.startsWith("../");
}

interface BootstrapPayload {
  summary: {
    projectTypes: string[];
    languages: string[];
    indexedFileCount: number;
  };
  graph: {
    nodes: Array<{
      relativePath?: string;
      [key: string]: unknown;
    }>;
  };
  layout: unknown[];
  conversation: Array<{
    role: "user" | "assistant";
    content: string;
    mode: "local" | "openai";
  }>;
  activeActTask: unknown | null;
  terminals: unknown[];
  index: {
    phase: string;
  };
}
