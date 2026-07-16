import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChokidarOptions, FSWatcher } from "chokidar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConstelixDatabase } from "./database.js";
import { EventBus } from "./events.js";
import { WorkspaceIndexer, type IndexStatus } from "./indexer.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("WorkspaceIndexer incremental updates", () => {
  it("does not become ready until the watcher baseline is established and reconciled", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-watcher-ready-"));
    temporaryRoots.push(root);
    await writeFile(join(root, "main.ts"), "export const beforeWatcherReady = true;\n");

    const database = new ConstelixDatabase(":memory:");
    database.upsertWorkspace("workspace", root);
    const events = new EventBus();
    const watcher = new EventEmitter() as EventEmitter & {
      close: () => Promise<void>;
    };
    watcher.close = vi.fn(async () => undefined);
    const watcherFactory = vi.fn(
      (_path: string, _options: ChokidarOptions) => watcher as unknown as FSWatcher,
    );
    const indexer = new WorkspaceIndexer("workspace", root, database, events, {
      watcherFactory,
    });

    try {
      await indexer.start();
      await waitForStatus(
        indexer,
        (status) => status.message === "Synchronizing filesystem watcher",
      );
      expect(indexer.status.phase).not.toBe("ready");
      expect(indexer.status.revision).toBe(0);

      await writeFile(
        join(root, "main.ts"),
        "export function changedDuringWatcherCrawl(): number { return 43; }\n",
      );
      watcher.emit("ready");

      await waitForReadyRevision(indexer, 1);
      expect(
        indexer.graph.snapshot(500).nodes.some((node) => node.name === "changedDuringWatcherCrawl"),
      ).toBe(true);
      expect(
        indexer.graph.snapshot(500).nodes.some((node) => node.name === "beforeWatcherReady"),
      ).toBe(false);
    } finally {
      await indexer.close();
      events.close();
      database.close();
    }
  }, 15_000);

  it("updates, creates and deletes source files without another full scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-incremental-"));
    temporaryRoots.push(root);
    await writeFile(join(root, "main.ts"), "export const answer = 42;\n");
    await writeFile(join(root, "stable.ts"), "export const stable = true;\n");

    const database = new ConstelixDatabase(":memory:");
    database.upsertWorkspace("workspace", root);
    const events = new EventBus();
    const indexer = new WorkspaceIndexer("workspace", root, database, events);
    const replaceIndexRevision = vi.spyOn(database, "replaceIndexRevision");
    const applyGraphDelta = vi.spyOn(database, "applyGraphDelta");
    const graphDeltas: unknown[] = [];
    const unsubscribe = events.subscribe((event) => {
      if (event.type === "graph.delta") graphDeltas.push(event.payload);
    });

    try {
      await indexer.start();
      await waitForReadyRevision(indexer, 1);
      expect(replaceIndexRevision).toHaveBeenCalledTimes(1);
      replaceIndexRevision.mockClear();
      applyGraphDelta.mockClear();
      graphDeltas.length = 0;

      await writeFile(
        join(root, "main.ts"),
        "export function updatedAnswer(): number { return 43; }\n",
      );
      indexer.notifyPathChanged("main.ts", 0);
      await waitForReadyRevision(indexer, 2);
      expect(replaceIndexRevision).not.toHaveBeenCalled();
      expect(applyGraphDelta).toHaveBeenCalledTimes(1);
      expect(indexer.status).toMatchObject({ completed: 2, total: 2 });
      expect(
        indexer.graph.snapshot(500).nodes.some((node) => node.name === "updatedAnswer"),
      ).toBe(true);

      await writeFile(join(root, "added.py"), "def newly_added():\n    return 7\n");
      await waitForReadyRevision(indexer, 3);
      expect(replaceIndexRevision).not.toHaveBeenCalled();
      expect(applyGraphDelta).toHaveBeenCalledTimes(2);
      expect(
        indexer.graph.snapshot(500).nodes.some((node) => node.name === "newly_added"),
      ).toBe(true);

      await unlink(join(root, "main.ts"));
      await waitForReadyRevision(indexer, 4);
      expect(replaceIndexRevision).not.toHaveBeenCalled();
      expect(applyGraphDelta).toHaveBeenCalledTimes(3);
      expect(
        indexer.graph.snapshot(500).nodes.some((node) => node.relativePath === "main.ts"),
      ).toBe(false);
      expect(graphDeltas).toHaveLength(3);
      expect(database.loadGraph("workspace")?.revision).toBe(4);
    } finally {
      unsubscribe();
      await indexer.close();
      events.close();
      database.close();
    }
  }, 15_000);

  it("falls back to a full reconciliation when ignore rules change", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-index-rules-"));
    temporaryRoots.push(root);
    await writeFile(join(root, "main.ts"), "export const answer = 42;\n");

    const database = new ConstelixDatabase(":memory:");
    database.upsertWorkspace("workspace", root);
    const events = new EventBus();
    const indexer = new WorkspaceIndexer("workspace", root, database, events);
    const replaceIndexRevision = vi.spyOn(database, "replaceIndexRevision");
    const applyGraphDelta = vi.spyOn(database, "applyGraphDelta");
    try {
      await indexer.start();
      await waitForReadyRevision(indexer, 1);
      replaceIndexRevision.mockClear();
      applyGraphDelta.mockClear();

      await writeFile(join(root, ".constelixignore"), "ignored.ts\n");
      await waitForReadyRevision(indexer, 2);
      expect(replaceIndexRevision).toHaveBeenCalledTimes(1);
      expect(applyGraphDelta).not.toHaveBeenCalled();
    } finally {
      await indexer.close();
      events.close();
      database.close();
    }
  }, 15_000);

  it("applies tsconfig path aliases through the worker pipeline", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-index-alias-"));
    temporaryRoots.push(root);
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@fixture/*": ["src/*"] },
        },
      }),
    );
    await writeFile(
      join(root, "api.ts"),
      `import { service } from "@fixture/service"; export const api = service();\n`,
    );
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "service.ts"), "export function service() { return 1; }\n");

    const database = new ConstelixDatabase(":memory:");
    database.upsertWorkspace("workspace", root);
    const events = new EventBus();
    const indexer = new WorkspaceIndexer("workspace", root, database, events);
    try {
      await indexer.start();
      await waitForReadyRevision(indexer, 1);
      const snapshot = indexer.graph.snapshot(500);
      const apiModule = snapshot.nodes.find(
        (node) => node.kind === "module" && node.relativePath === "api.ts",
      );
      const edge = snapshot.edges.find(
        (candidate) =>
          candidate.source === apiModule?.id && candidate.relation === "imports",
      );
      expect(edge?.confidence).toBe("resolved");
      expect(snapshot.nodes.find((node) => node.id === edge?.target)?.relativePath).toBe(
        "src/service.ts",
      );
    } finally {
      await indexer.close();
      events.close();
      database.close();
    }
  }, 15_000);

  it("publishes a bounded provisional file graph before the cold semantic graph is ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-provisional-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "src"));
    await Promise.all(
      Array.from({ length: 520 }, (_, index) =>
        writeFile(join(root, "src", `module-${index}.ts`), `export const value${index} = ${index};\n`),
      ),
    );

    const database = new ConstelixDatabase(":memory:");
    database.upsertWorkspace("workspace", root);
    const events = new EventBus();
    const timeline: Array<{ type: string; payload: unknown }> = [];
    const unsubscribe = events.subscribe((event) => {
      timeline.push({ type: event.type, payload: event.payload });
    });
    const watcher = createFakeWatcher();
    const indexer = new WorkspaceIndexer("workspace", root, database, events, {
      watcherFactory: () => watcher as unknown as FSWatcher,
    });
    try {
      await indexer.start();
      watcher.emit("ready");
      await waitForReadyRevision(indexer, 1);

      const snapshots = timeline
        .filter((event) => event.type === "graph.snapshot")
        .map((event) => event.payload as {
          graph: { nodes: unknown[]; truncated: boolean };
          provisional?: boolean;
        });
      expect(snapshots[0]?.provisional).toBe(true);
      expect(snapshots[0]?.graph.nodes.length).toBeLessThanOrEqual(500);
      expect(snapshots[0]?.graph.truncated).toBe(true);
      expect(snapshots.every((snapshot) => snapshot.graph.nodes.length <= 500)).toBe(true);
      expect(timeline.some((event) => event.type === "graph.delta")).toBe(false);

      const provisionalIndex = timeline.findIndex(
        (event) =>
          event.type === "graph.snapshot" &&
          (event.payload as { provisional?: boolean }).provisional === true,
      );
      const readyIndex = timeline.findIndex(
        (event) =>
          event.type === "index.progress" &&
          (event.payload as { phase?: string }).phase === "ready",
      );
      expect(provisionalIndex).toBeGreaterThanOrEqual(0);
      expect(readyIndex).toBeGreaterThan(provisionalIndex);
    } finally {
      unsubscribe();
      await indexer.close();
      events.close();
      database.close();
    }
  }, 20_000);

  it("restarts a failed ready watcher with backoff and performs a full reconciliation", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-watcher-recovery-"));
    temporaryRoots.push(root);
    await writeFile(join(root, "main.ts"), "export const beforeRecovery = true;\n");

    const database = new ConstelixDatabase(":memory:");
    database.upsertWorkspace("workspace", root);
    const events = new EventBus();
    const watchers = [createFakeWatcher(), createFakeWatcher()];
    const watcherFactory = vi.fn(
      (_path: string, _options: ChokidarOptions) =>
        watchers[Math.min(watcherFactory.mock.calls.length - 1, watchers.length - 1)] as unknown as FSWatcher,
    );
    const indexer = new WorkspaceIndexer("workspace", root, database, events, {
      watcherFactory,
      watcherRestartBaseDelayMs: 1,
      watcherRestartMaxDelayMs: 4,
    });
    try {
      await indexer.start();
      watchers[0]?.emit("ready");
      await waitForReadyRevision(indexer, 1);

      watchers[0]?.emit("error", new Error("watcher failed after ready"));
      await writeFile(
        join(root, "main.ts"),
        "export function recoveredWatcher(): number { return 7; }\n",
      );
      await waitForCondition(() => watcherFactory.mock.calls.length >= 2);
      watchers[1]?.emit("ready");

      await waitForReadyRevision(indexer, 2);
      expect(watchers[0]?.close).toHaveBeenCalledTimes(1);
      expect(
        indexer.graph.snapshot(500).nodes.some((node) => node.name === "recoveredWatcher"),
      ).toBe(true);
    } finally {
      await indexer.close();
      events.close();
      database.close();
    }
  }, 15_000);

  it("keeps the initial index pending while a failed pre-ready watcher is replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-watcher-pre-ready-recovery-"));
    temporaryRoots.push(root);
    await writeFile(
      join(root, "main.ts"),
      "export function recoveredBeforeReady(): boolean { return true; }\n",
    );

    const database = new ConstelixDatabase(":memory:");
    database.upsertWorkspace("workspace", root);
    const events = new EventBus();
    const watchers = [createFakeWatcher(), createFakeWatcher()];
    const watcherFactory = vi.fn(
      (_path: string, _options: ChokidarOptions) =>
        watchers[Math.min(watcherFactory.mock.calls.length - 1, watchers.length - 1)] as unknown as FSWatcher,
    );
    const indexer = new WorkspaceIndexer("workspace", root, database, events, {
      watcherFactory,
      watcherRestartBaseDelayMs: 1,
      watcherRestartMaxDelayMs: 4,
    });
    try {
      await indexer.start();
      watchers[0]?.emit("error", new Error("watcher failed before ready"));
      await waitForCondition(() => watcherFactory.mock.calls.length >= 2);
      expect(indexer.status.phase).not.toBe("ready");

      watchers[1]?.emit("ready");
      await waitForReadyRevision(indexer, 1);

      expect(watchers[0]?.close).toHaveBeenCalledTimes(1);
      expect(
        indexer.graph.snapshot(500).nodes.some((node) => node.name === "recoveredBeforeReady"),
      ).toBe(true);
    } finally {
      await indexer.close();
      events.close();
      database.close();
    }
  }, 15_000);
});

async function waitForReadyRevision(
  indexer: WorkspaceIndexer,
  revision: number,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (indexer.status.phase === "ready" && indexer.status.revision >= revision) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Indexer did not reach ready revision ${revision}; current state is ${JSON.stringify(indexer.status)}`,
  );
}

async function waitForStatus(
  indexer: WorkspaceIndexer,
  predicate: (status: Readonly<IndexStatus>) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate(indexer.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Indexer did not reach expected status; current state is ${JSON.stringify(indexer.status)}`);
}

function createFakeWatcher(): EventEmitter & { close: ReturnType<typeof vi.fn> } {
  const watcher = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
  watcher.close = vi.fn(async () => undefined);
  return watcher;
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not reached before timeout.");
}
