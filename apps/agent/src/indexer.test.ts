import { EventEmitter } from "node:events";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
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
    const replaceGraph = vi.spyOn(database, "replaceGraph");
    const applyGraphDelta = vi.spyOn(database, "applyGraphDelta");
    const graphDeltas: unknown[] = [];
    const unsubscribe = events.subscribe((event) => {
      if (event.type === "graph.delta") graphDeltas.push(event.payload);
    });

    try {
      await indexer.start();
      await waitForReadyRevision(indexer, 1);
      expect(replaceGraph).toHaveBeenCalledTimes(1);
      replaceGraph.mockClear();
      applyGraphDelta.mockClear();
      graphDeltas.length = 0;

      await writeFile(
        join(root, "main.ts"),
        "export function updatedAnswer(): number { return 43; }\n",
      );
      await waitForReadyRevision(indexer, 2);
      expect(replaceGraph).not.toHaveBeenCalled();
      expect(applyGraphDelta).toHaveBeenCalledTimes(1);
      expect(
        indexer.graph.snapshot(500).nodes.some((node) => node.name === "updatedAnswer"),
      ).toBe(true);

      await writeFile(join(root, "added.py"), "def newly_added():\n    return 7\n");
      await waitForReadyRevision(indexer, 3);
      expect(replaceGraph).not.toHaveBeenCalled();
      expect(applyGraphDelta).toHaveBeenCalledTimes(2);
      expect(
        indexer.graph.snapshot(500).nodes.some((node) => node.name === "newly_added"),
      ).toBe(true);

      await unlink(join(root, "main.ts"));
      await waitForReadyRevision(indexer, 4);
      expect(replaceGraph).not.toHaveBeenCalled();
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
    const replaceGraph = vi.spyOn(database, "replaceGraph");
    const applyGraphDelta = vi.spyOn(database, "applyGraphDelta");
    try {
      await indexer.start();
      await waitForReadyRevision(indexer, 1);
      replaceGraph.mockClear();
      applyGraphDelta.mockClear();

      await writeFile(join(root, ".constelixignore"), "ignored.ts\n");
      await waitForReadyRevision(indexer, 2);
      expect(replaceGraph).toHaveBeenCalledTimes(1);
      expect(applyGraphDelta).not.toHaveBeenCalled();
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
