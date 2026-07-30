import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkspaceId } from "./security.js";
import {
  type RunningAgentServer,
  startAgentServer,
} from "./server.js";
import {
  WorkspaceRuntimeManager,
  WorkspaceSessionChangedError,
  WorkspaceSwitchInProgressError,
} from "./workspace-manager.js";
import { WorkspaceRuntime } from "./workspace-runtime.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("Constelix v0.0.5 workspace runtime", () => {
  it("owns an isolated lease, indexes its root, and closes idempotently", async () => {
    const parent = await temporaryDirectory("constelix-v005-runtime-");
    const workspaceRoot = join(parent, "workspace");
    const storageDirectory = join(parent, "state", "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(
      join(workspaceRoot, "runtime.ts"),
      "export const runtimeMarker = 'isolated';\n",
    );

    const runtime = await WorkspaceRuntime.create({
      workspaceRoot,
      readOnly: true,
      storageDirectory,
      databasePath: join(parent, "state", "workspace.sqlite"),
      askOptions: { apiKey: "" },
    });

    try {
      await runtime.start();
      await waitUntil(() => runtime.indexer.status.phase === "ready");

      expect(runtime.workspaceRoot).toBe(await realpath(workspaceRoot));
      expect(runtime.workspaceId).toBe(
        createWorkspaceId(await realpath(workspaceRoot)),
      );
      expect(runtime.session).toMatchObject({
        workspaceId: runtime.workspaceId,
      });
      expect(runtime.session.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(runtime.codex).toBeUndefined();
      expect(runtime.indexer.graph.snapshot(100).nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ relativePath: "runtime.ts" }),
        ]),
      );
      expect(runtime.availability()).toMatchObject({
        javascript: { available: expect.any(Boolean) },
        typescript: { available: expect.any(Boolean) },
        python: { available: expect.any(Boolean) },
      });
      await expect(access(join(storageDirectory, "agent.lock"))).resolves.toBe(
        undefined,
      );
      await expect(runtime.assertHealthy()).resolves.toBeUndefined();
    } finally {
      await runtime.close();
      await runtime.close();
    }

    await expect(access(join(storageDirectory, "agent.lock"))).rejects.toThrow();
    await expect(runtime.assertHealthy()).rejects.toMatchObject({
      code: "WORKSPACE_LEASE_LOST",
    });
  }, 20_000);
});

describe("Constelix v0.0.5 workspace runtime manager", () => {
  it("rejects manager state paths inside the initial or a future workspace", async () => {
    const fixture = await createTwoWorkspaceFixture(
      "constelix-v005-manager-state-",
    );
    const unsafeInitialState = join(fixture.firstRoot, ".constelix");
    await expect(
      WorkspaceRuntimeManager.create({
        workspaceRoot: fixture.firstRoot,
        storageDirectory: join(unsafeInitialState, "workspace"),
        globalDatabasePath: join(unsafeInitialState, "global.sqlite"),
        askOptions: { apiKey: "" },
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_VALIDATION_FAILED" });
    await expect(
      access(join(unsafeInitialState, "global.sqlite")),
    ).rejects.toThrow();

    const firstWorkspaceId = createWorkspaceId(
      await realpath(fixture.firstRoot),
    );
    const manager = await WorkspaceRuntimeManager.create({
      workspaceRoot: fixture.firstRoot,
      storageDirectory: join(fixture.stateRoot, firstWorkspaceId),
      databasePath: join(fixture.stateRoot, `${firstWorkspaceId}.sqlite`),
      globalDatabasePath: join(
        fixture.secondRoot,
        ".constelix",
        "global.sqlite",
      ),
      askOptions: { apiKey: "" },
    });
    try {
      const initial = manager.current;
      await expect(
        manager.open({
          target: { kind: "path", path: fixture.secondRoot },
          expectedSessionId: initial.session.id,
        }),
      ).rejects.toMatchObject({ code: "WORKSPACE_VALIDATION_FAILED" });
      expect(manager.current).toBe(initial);
      await expect(initial.assertHealthy()).resolves.toBeUndefined();
    } finally {
      await manager.close();
    }
  }, 20_000);

  it("switches transactionally, rejects stale sessions, and preserves recents", async () => {
    const fixture = await createTwoWorkspaceFixture("constelix-v005-manager-");
    const firstWorkspaceId = createWorkspaceId(
      await realpath(fixture.firstRoot),
    );
    const manager = await WorkspaceRuntimeManager.create({
      workspaceRoot: fixture.firstRoot,
      readOnly: true,
      storageDirectory: join(fixture.stateRoot, firstWorkspaceId),
      databasePath: join(fixture.stateRoot, `${firstWorkspaceId}.sqlite`),
      globalDatabasePath: join(fixture.stateRoot, "global.sqlite"),
      askOptions: { apiKey: "" },
    });
    const workspaceChangedEvents: unknown[] = [];
    const unsubscribe = manager.globalEvents.subscribe((event) => {
      if (event.type === "workspace.changed") {
        workspaceChangedEvents.push(event);
      }
    });

    try {
      await waitUntil(() => manager.current.indexer.status.phase === "ready");
      const first = manager.current;
      const firstSession = first.session;
      const firstStorageDirectory = first.storageDirectory;

      const second = await manager.open({
        target: { kind: "path", path: fixture.secondRoot },
        expectedSessionId: firstSession.id,
      });
      await waitUntil(() => second.indexer.status.phase === "ready");

      expect(second.workspaceId).not.toBe(first.workspaceId);
      expect(second.session.id).not.toBe(firstSession.id);
      expect(second.workspace.readOnly).toBe(true);
      expect(second.codex).toBeUndefined();
      expect(manager.current).toBe(second);
      expect(workspaceChangedEvents).toEqual([
        expect.objectContaining({
          type: "workspace.changed",
          sessionId: second.session.id,
          workspaceId: second.workspaceId,
          payload: { session: second.session },
        }),
      ]);
      expect(() => manager.capture(firstSession.id)).toThrow(
        WorkspaceSessionChangedError,
      );
      try {
        manager.capture(firstSession.id);
      } catch (error) {
        expect(error).toMatchObject({
          code: "WORKSPACE_SESSION_CHANGED",
          activeSession: second.session,
        });
      }
      await expect(
        access(join(firstStorageDirectory, "agent.lock")),
      ).rejects.toThrow();

      const recents = await manager.listRecentWorkspaces();
      expect(recents.map((workspace) => workspace.workspaceId)).toEqual([
        second.workspaceId,
        first.workspaceId,
      ]);
      expect(JSON.stringify(recents)).not.toContain(fixture.firstRoot);
      expect(JSON.stringify(recents)).not.toContain(fixture.secondRoot);

      await expect(
        manager.open({
          target: { kind: "path", path: join(fixture.parent, "missing") },
          expectedSessionId: second.session.id,
        }),
      ).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
      expect(manager.current).toBe(second);
      await expect(manager.current.assertHealthy()).resolves.toBeUndefined();

      const firstAgain = await manager.open({
        target: { kind: "recent", workspaceId: first.workspaceId },
        expectedSessionId: second.session.id,
      });
      expect(firstAgain.workspaceId).toBe(first.workspaceId);
      expect(firstAgain.session.id).not.toBe(firstSession.id);
      await expect(
        access(join(second.storageDirectory, "agent.lock")),
      ).rejects.toThrow();
    } finally {
      unsubscribe();
      await manager.close();
      await manager.close();
    }
  }, 30_000);

  it("keeps a committed candidate active when previous teardown reports an error", async () => {
    const fixture = await createTwoWorkspaceFixture(
      "constelix-v005-manager-cleanup-",
    );
    const firstWorkspaceId = createWorkspaceId(
      await realpath(fixture.firstRoot),
    );
    const manager = await WorkspaceRuntimeManager.create({
      workspaceRoot: fixture.firstRoot,
      readOnly: true,
      storageDirectory: join(fixture.stateRoot, firstWorkspaceId),
      databasePath: join(fixture.stateRoot, `${firstWorkspaceId}.sqlite`),
      globalDatabasePath: join(fixture.stateRoot, "global.sqlite"),
      askOptions: { apiKey: "" },
    });
    const first = manager.current;
    const closeFirst = first.close.bind(first);
    const closeSpy = vi
      .spyOn(first, "close")
      .mockRejectedValueOnce(
        new Error(`${fixture.firstRoot}/secret.txt teardown failed`),
      );

    try {
      const second = await manager.open({
        target: { kind: "path", path: fixture.secondRoot },
        expectedSessionId: first.session.id,
      });

      expect(manager.current).toBe(second);
      await expect(second.assertHealthy()).resolves.toBeUndefined();
      expect(
        (await manager.listRecentWorkspaces()).map(
          (workspace) => workspace.workspaceId,
        ),
      ).toEqual([second.workspaceId, first.workspaceId]);
    } finally {
      closeSpy.mockRestore();
      await closeFirst();
      await manager.close();
    }
  }, 20_000);

  it("publishes the new session only after slow prior-runtime cleanup releases the switch barrier", async () => {
    const fixture = await createTwoWorkspaceFixture(
      "constelix-v005-manager-public-commit-",
    );
    const firstWorkspaceId = createWorkspaceId(
      await realpath(fixture.firstRoot),
    );
    const manager = await WorkspaceRuntimeManager.create({
      workspaceRoot: fixture.firstRoot,
      readOnly: true,
      storageDirectory: join(fixture.stateRoot, firstWorkspaceId),
      databasePath: join(fixture.stateRoot, `${firstWorkspaceId}.sqlite`),
      globalDatabasePath: join(fixture.stateRoot, "global.sqlite"),
      askOptions: { apiKey: "" },
    });
    const first = manager.current;
    const closeFirst = first.close.bind(first);
    const cleanupStarted = deferred<void>();
    const releaseCleanup = deferred<void>();
    const observedEvents: unknown[] = [];
    const captureErrors: unknown[] = [];
    const unsubscribe = manager.globalEvents.subscribe((event) => {
      if (event.type !== "workspace.changed") return;
      observedEvents.push(event);
      try {
        if (!event.sessionId) {
          throw new Error("workspace.changed omitted its session ID.");
        }
        manager.capture(event.sessionId);
      } catch (error) {
        captureErrors.push(error);
      }
    });
    const closeSpy = vi.spyOn(first, "close").mockImplementationOnce(
      async () => {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
        await closeFirst();
      },
    );

    try {
      const opening = manager.open({
        target: { kind: "path", path: fixture.secondRoot },
        expectedSessionId: first.session.id,
      });
      await cleanupStarted.promise;

      expect(observedEvents).toEqual([]);
      expect(() => manager.capture()).toThrow(
        WorkspaceSwitchInProgressError,
      );

      releaseCleanup.resolve();
      const second = await opening;
      expect(observedEvents).toEqual([
        expect.objectContaining({
          type: "workspace.changed",
          sessionId: second.session.id,
          workspaceId: second.workspaceId,
        }),
      ]);
      expect(captureErrors).toEqual([]);
      expect(manager.capture(second.session.id)).toBe(second);
    } finally {
      releaseCleanup.resolve();
      unsubscribe();
      closeSpy.mockRestore();
      await manager.close();
    }
  }, 20_000);
});

describe("Constelix v0.0.5 workspace HTTP routes", () => {
  it("browses, hot-swaps, isolates roots, and reports obsolete sessions", async () => {
    const fixture = await createTwoWorkspaceFixture("constelix-v005-server-");
    await mkdir(join(fixture.projectsRoot, ".hidden-workspace"));
    const initialWorkspaceId = createWorkspaceId(
      await realpath(fixture.firstRoot),
    );
    const server = await startAgentServer({
      workspaceRoot: fixture.firstRoot,
      readOnly: true,
      port: 0,
      capabilityToken: "v005-capability",
      storageDirectory: join(fixture.stateRoot, initialWorkspaceId),
      databasePath: join(
        fixture.stateRoot,
        `${initialWorkspaceId}.sqlite`,
      ),
      globalDatabasePath: join(fixture.stateRoot, "global.sqlite"),
      webDistPath: join(fixture.parent, "missing-web-dist"),
      askOptions: { apiKey: "" },
    });

    try {
      const firstBootstrap = await waitForReady(server);
      const firstSession = firstBootstrap.session;
      expect(firstBootstrap.workspace.name).toBe("workspace-a");
      expect(pathsFromBootstrap(firstBootstrap)).toContain("main.ts");

      const missingSession = await request(server, {
        method: "POST",
        url: "/api/v1/files/read",
        payload: { protocolVersion: 1, relativePath: "main.ts" },
      });
      expect(missingSession.statusCode).toBe(409);
      expect(missingSession.json()).toMatchObject({
        error: {
          code: "WORKSPACE_SESSION_CHANGED",
          details: { activeSession: firstSession },
        },
      });

      const initialList = await request(server, {
        method: "GET",
        url: "/api/v1/workspaces",
        sessionId: firstSession.id,
      });
      expect(initialList.statusCode).toBe(200);
      expect(initialList.json()).toMatchObject({
        protocolVersion: 1,
        activeSession: firstSession,
        recents: [
          {
            workspaceId: firstSession.workspaceId,
            name: "workspace-a",
            availability: "available",
            lastMode: "read",
          },
        ],
      });
      expect(initialList.body).not.toContain(fixture.firstRoot);

      const browse = await request(server, {
        method: "GET",
        url:
          `/api/v1/fs/browse?path=${encodeURIComponent(fixture.projectsRoot)}` +
          "&limit=10",
        sessionId: firstSession.id,
      });
      expect(browse.statusCode).toBe(200);
      expect(
        (browse.json() as WorkspaceBrowsePayload).entries.map(
          (entry) => entry.name,
        ),
      ).toEqual(["workspace-a", "workspace-b"]);

      const openSecond = await request(server, {
        method: "POST",
        url: "/api/v1/workspaces/open",
        sessionId: firstSession.id,
        payload: {
          protocolVersion: 1,
          requestId: randomUUID(),
          target: { kind: "path", path: fixture.secondRoot },
          expectedSessionId: firstSession.id,
        },
      });
      expect(openSecond.statusCode).toBe(200);
      const secondSession = (openSecond.json() as WorkspaceOpenPayload).session;
      expect(openSecond.json()).toMatchObject({
        protocolVersion: 1,
        bootstrap: {
          session: secondSession,
          workspace: { name: "workspace-b", readOnly: true },
        },
      });
      expect(secondSession.workspaceId).not.toBe(firstSession.workspaceId);
      expect(secondSession.id).not.toBe(firstSession.id);

      const staleBootstrap = await request(server, {
        method: "GET",
        url: "/api/v1/bootstrap",
        sessionId: firstSession.id,
      });
      expect(staleBootstrap.statusCode).toBe(409);
      expect(staleBootstrap.json()).toMatchObject({
        error: {
          code: "WORKSPACE_SESSION_CHANGED",
          recoverable: true,
          details: { activeSession: secondSession },
        },
      });

      const secondBootstrap = await waitForReady(server, secondSession.id);
      expect(secondBootstrap.workspace).toMatchObject({
        id: secondSession.workspaceId,
        name: "workspace-b",
        mode: "read",
        readOnly: true,
      });
      const secondRead = await request(server, {
        method: "POST",
        url: "/api/v1/files/read",
        sessionId: secondSession.id,
        payload: { protocolVersion: 1, relativePath: "main.ts" },
      });
      expect(secondRead.statusCode).toBe(200);
      expect(secondRead.json()).toMatchObject({
        relativePath: "main.ts",
        content: "export const workspaceMarker = 'workspace-b';\n",
      });
      const secondFile = secondRead.json() as {
        content: string;
        contentHash: string;
      };
      const forbiddenWrite = await request(server, {
        method: "PUT",
        url: "/api/v1/files/write",
        sessionId: secondSession.id,
        payload: {
          protocolVersion: 1,
          relativePath: "main.ts",
          content: secondFile.content,
          expectedContentHash: secondFile.contentHash,
        },
      });
      expect(forbiddenWrite.statusCode).toBe(403);
      expect(forbiddenWrite.json()).toMatchObject({
        error: { code: "WORKSPACE_READ_ONLY" },
      });

      const failedSwitch = await request(server, {
        method: "POST",
        url: "/api/v1/workspaces/open",
        sessionId: secondSession.id,
        payload: {
          protocolVersion: 1,
          requestId: randomUUID(),
          target: { kind: "path", path: join(fixture.parent, "missing") },
          expectedSessionId: secondSession.id,
        },
      });
      expect(failedSwitch.statusCode).toBe(404);
      expect(failedSwitch.json()).toMatchObject({
        error: { code: "WORKSPACE_NOT_FOUND" },
      });
      const healthAfterFailure = await request(server, {
        method: "GET",
        url: "/api/v1/health",
        sessionId: secondSession.id,
      });
      expect(healthAfterFailure.statusCode).toBe(200);
      expect(healthAfterFailure.json()).toMatchObject({
        workspaceId: secondSession.workspaceId,
        session: secondSession,
      });

      const recents = await request(server, {
        method: "GET",
        url: "/api/v1/workspaces",
        sessionId: secondSession.id,
      });
      expect(recents.statusCode).toBe(200);
      const recentPayload = recents.json() as WorkspaceListPayload;
      expect(recentPayload.recents.map((entry) => entry.workspaceId)).toEqual([
        secondSession.workspaceId,
        firstSession.workspaceId,
      ]);
      expect(recents.body).not.toContain(fixture.firstRoot);
      expect(recents.body).not.toContain(fixture.secondRoot);

      const reopenFirst = await request(server, {
        method: "POST",
        url: "/api/v1/workspaces/open",
        sessionId: secondSession.id,
        payload: {
          protocolVersion: 1,
          requestId: randomUUID(),
          target: {
            kind: "recent",
            workspaceId: firstSession.workspaceId,
          },
          expectedSessionId: secondSession.id,
        },
      });
      expect(reopenFirst.statusCode).toBe(200);
      const thirdSession = (reopenFirst.json() as WorkspaceOpenPayload).session;
      expect(thirdSession.workspaceId).toBe(firstSession.workspaceId);
      expect(thirdSession.id).not.toBe(firstSession.id);

      const firstRead = await request(server, {
        method: "POST",
        url: "/api/v1/files/read",
        sessionId: thirdSession.id,
        payload: { protocolVersion: 1, relativePath: "main.ts" },
      });
      expect(firstRead.statusCode).toBe(200);
      expect(firstRead.json()).toMatchObject({
        content: "export const workspaceMarker = 'workspace-a';\n",
      });

      const staleSecondRead = await request(server, {
        method: "POST",
        url: "/api/v1/files/read",
        sessionId: secondSession.id,
        payload: { protocolVersion: 1, relativePath: "main.ts" },
      });
      expect(staleSecondRead.statusCode).toBe(409);
      expect(staleSecondRead.json()).toMatchObject({
        error: {
          code: "WORKSPACE_SESSION_CHANGED",
          details: { activeSession: thirdSession },
        },
      });
    } finally {
      await server.close();
      await server.close();
    }
  }, 40_000);
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

async function createTwoWorkspaceFixture(prefix: string): Promise<{
  parent: string;
  projectsRoot: string;
  stateRoot: string;
  firstRoot: string;
  secondRoot: string;
}> {
  const parent = await temporaryDirectory(prefix);
  const projectsRoot = join(parent, "projects");
  const stateRoot = join(parent, "state");
  const firstRoot = join(projectsRoot, "workspace-a");
  const secondRoot = join(projectsRoot, "workspace-b");
  await Promise.all([
    mkdir(firstRoot, { recursive: true }),
    mkdir(secondRoot, { recursive: true }),
    mkdir(stateRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(firstRoot, "main.ts"),
      "export const workspaceMarker = 'workspace-a';\n",
    ),
    writeFile(
      join(secondRoot, "main.ts"),
      "export const workspaceMarker = 'workspace-b';\n",
    ),
  ]);
  return { parent, projectsRoot, stateRoot, firstRoot, secondRoot };
}

async function waitForReady(
  server: RunningAgentServer,
  sessionId?: string,
): Promise<BootstrapPayload> {
  let latest: BootstrapPayload | undefined;
  await waitUntil(async () => {
    const response = await request(server, {
      method: "GET",
      url: "/api/v1/bootstrap",
      ...(sessionId ? { sessionId } : {}),
    });
    expect(response.statusCode).toBe(200);
    latest = response.json() as BootstrapPayload;
    return latest.index.phase === "ready";
  });
  if (!latest) throw new Error("Bootstrap polling produced no response.");
  return latest;
}

async function request(
  server: RunningAgentServer,
  input: {
    method: "GET" | "POST" | "PUT";
    url: string;
    sessionId?: string;
    payload?: Record<string, unknown>;
  },
) {
  return await server.app.inject({
    method: input.method,
    url: input.url,
    headers: {
      host: new URL(server.origin).host,
      authorization: `Bearer ${server.capabilityToken}`,
      ...(input.sessionId
        ? { "x-constelix-workspace-session": input.sessionId }
        : {}),
      ...(input.payload === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  });
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

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value?: T) => resolvePromise(value as T),
    reject: rejectPromise,
  };
}

function pathsFromBootstrap(payload: BootstrapPayload): string[] {
  return payload.graph.nodes
    .map((node) => node.relativePath)
    .filter((path): path is string => typeof path === "string");
}

interface WorkspaceSessionPayload {
  id: string;
  workspaceId: string;
  activatedAt: string;
}

interface BootstrapPayload {
  session: WorkspaceSessionPayload;
  workspace: {
    id: string;
    name: string;
  };
  graph: {
    nodes: Array<{ relativePath?: string }>;
  };
  index: {
    phase: string;
  };
}

interface WorkspaceOpenPayload {
  session: WorkspaceSessionPayload;
}

interface WorkspaceBrowsePayload {
  entries: Array<{ name: string; path: string; symlink: boolean }>;
}

interface WorkspaceListPayload {
  recents: Array<{ workspaceId: string }>;
}
