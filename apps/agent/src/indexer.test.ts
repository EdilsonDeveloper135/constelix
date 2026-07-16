import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChokidarOptions, FSWatcher } from "chokidar";
import { PROTOCOL_VERSION, type GraphSnapshot } from "@constelix/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConstelixDatabase } from "./database.js";
import { EventBus } from "./events.js";
import {
  WorkspaceIndexer,
  mergeIncrementalSnapshot,
  type IndexStatus,
} from "./indexer.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("mergeIncrementalSnapshot", () => {
  it("does not clear source truncation during a merge", () => {
    const previous: GraphSnapshot = {
      protocolVersion: PROTOCOL_VERSION,
      workspaceId: "workspace",
      revision: 1,
      nodes: [],
      edges: [],
      truncated: true,
    };
    const partial: GraphSnapshot = {
      ...previous,
      revision: 2,
      truncated: false,
    };

    expect(
      mergeIncrementalSnapshot(previous, partial, new Set(), 2).truncated,
    ).toBe(true);
    expect(
      mergeIncrementalSnapshot(
        { ...previous, truncated: false },
        { ...partial, truncated: true },
        new Set(),
        2,
      ).truncated,
    ).toBe(true);
  });
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
    const watcher = createFakeWatcher();
    const indexer = new WorkspaceIndexer("workspace", root, database, events, {
      watcherFactory: () => watcher as unknown as FSWatcher,
    });
    const replaceIndexRevision = vi.spyOn(database, "replaceIndexRevision");
    const applyGraphDelta = vi.spyOn(database, "applyGraphDelta");
    const graphDeltas: unknown[] = [];
    const unsubscribe = events.subscribe((event) => {
      if (event.type === "graph.delta") graphDeltas.push(event.payload);
    });

    try {
      await indexer.start();
      watcher.emit("ready");
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
      indexer.notifyPathChanged("added.py", 0);
      await waitForReadyRevision(indexer, 3);
      expect(replaceIndexRevision).not.toHaveBeenCalled();
      expect(applyGraphDelta).toHaveBeenCalledTimes(2);
      expect(
        indexer.graph.snapshot(500).nodes.some((node) => node.name === "newly_added"),
      ).toBe(true);

      await unlink(join(root, "main.ts"));
      indexer.notifyPathChanged("main.ts", 0);
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

  it("reanalyzes an existing importer when a new module satisfies its import", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-incremental-import-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src", "api.ts"),
      `import { service } from "./service"; export const api = () => service();\n`,
    );

    const database = new ConstelixDatabase(":memory:");
    database.upsertWorkspace("workspace", root);
    const events = new EventBus();
    const watcher = createFakeWatcher();
    const indexer = new WorkspaceIndexer("workspace", root, database, events, {
      watcherFactory: () => watcher as unknown as FSWatcher,
    });
    const replaceIndexRevision = vi.spyOn(database, "replaceIndexRevision");
    const applyGraphDelta = vi.spyOn(database, "applyGraphDelta");

    try {
      await indexer.start();
      watcher.emit("ready");
      await waitForReadyRevision(indexer, 1);
      const initial = indexer.graph.snapshot(500);
      const initialApi = initial.nodes.find(
        (node) => node.kind === "module" && node.relativePath === "src/api.ts",
      );
      const initialImport = initial.edges.find(
        (edge) => edge.source === initialApi?.id && edge.relation === "imports",
      );
      expect(initialImport?.confidence).toBe("extracted");
      expect(initial.nodes.find((node) => node.id === initialImport?.target)?.kind).toBe(
        "external",
      );

      replaceIndexRevision.mockClear();
      applyGraphDelta.mockClear();
      await writeFile(
        join(root, "src", "service.ts"),
        "export function service() { return 1; }\n",
      );
      indexer.notifyPathChanged("src/service.ts", 0);
      await waitForReadyRevision(indexer, 2);

      const updated = indexer.graph.snapshot(500);
      const updatedApi = updated.nodes.find(
        (node) => node.kind === "module" && node.relativePath === "src/api.ts",
      );
      const updatedImport = updated.edges.find(
        (edge) => edge.source === updatedApi?.id && edge.relation === "imports",
      );
      expect(updatedImport?.confidence).toBe("inferred");
      expect(updated.nodes.find((node) => node.id === updatedImport?.target)).toMatchObject({
        kind: "module",
        relativePath: "src/service.ts",
      });
      expect(replaceIndexRevision).not.toHaveBeenCalled();
      expect(applyGraphDelta).toHaveBeenCalledTimes(1);
    } finally {
      await indexer.close();
      events.close();
      database.close();
    }
  }, 15_000);

  it("coalesces a rapid rename into one incremental graph revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-incremental-rename-"));
    temporaryRoots.push(root);
    await writeFile(join(root, "before.ts"), "export const before = true;\n");

    const database = new ConstelixDatabase(":memory:");
    database.upsertWorkspace("workspace", root);
    const events = new EventBus();
    const watcher = createFakeWatcher();
    const indexer = new WorkspaceIndexer("workspace", root, database, events, {
      watcherFactory: () => watcher as unknown as FSWatcher,
    });
    const applyGraphDelta = vi.spyOn(database, "applyGraphDelta");

    try {
      await indexer.start();
      watcher.emit("ready");
      await waitForReadyRevision(indexer, 1);
      applyGraphDelta.mockClear();

      await rename(join(root, "before.ts"), join(root, "after.ts"));
      indexer.notifyPathChanged("before.ts", 25);
      indexer.notifyPathChanged("after.ts", 25);
      await waitForReadyRevision(indexer, 2);

      const snapshot = indexer.graph.snapshot(500);
      expect(snapshot.nodes.some((node) => node.relativePath === "before.ts")).toBe(false);
      expect(snapshot.nodes.some((node) => node.relativePath === "after.ts")).toBe(true);
      expect(applyGraphDelta).toHaveBeenCalledTimes(1);
    } finally {
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
    const watcher = createFakeWatcher();
    const indexer = new WorkspaceIndexer("workspace", root, database, events, {
      watcherFactory: () => watcher as unknown as FSWatcher,
    });
    const replaceIndexRevision = vi.spyOn(database, "replaceIndexRevision");
    const applyGraphDelta = vi.spyOn(database, "applyGraphDelta");
    try {
      await indexer.start();
      watcher.emit("ready");
      await waitForReadyRevision(indexer, 1);
      replaceIndexRevision.mockClear();
      applyGraphDelta.mockClear();

      await writeFile(join(root, ".constelixignore"), "ignored.ts\n");
      indexer.notifyPathChanged(".constelixignore", 0);
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
    const watcher = createFakeWatcher();
    const indexer = new WorkspaceIndexer("workspace", root, database, events, {
      watcherFactory: () => watcher as unknown as FSWatcher,
    });
    try {
      await indexer.start();
      watcher.emit("ready");
      await waitForReadyRevision(indexer, 1);
      const snapshot = indexer.graph.snapshot(500);
      const apiModule = snapshot.nodes.find(
        (node) => node.kind === "module" && node.relativePath === "api.ts",
      );
      const edge = snapshot.edges.find(
        (candidate) =>
          candidate.source === apiModule?.id && candidate.relation === "imports",
      );
      expect(edge?.confidence).toBe("inferred");
      expect(snapshot.nodes.find((node) => node.id === edge?.target)?.relativePath).toBe(
        "src/service.ts",
      );
    } finally {
      await indexer.close();
      events.close();
      database.close();
    }
  }, 15_000);

  it("includes a tsconfig alias target when an edit introduces the import", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-index-alias-edit-"));
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
      "export const api = () => 0;\n",
    );
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src", "service.ts"),
      "export function service() { return 1; }\n",
    );

    const database = new ConstelixDatabase(":memory:");
    database.upsertWorkspace("workspace", root);
    const events = new EventBus();
    const watcher = createFakeWatcher();
    const indexer = new WorkspaceIndexer("workspace", root, database, events, {
      watcherFactory: () => watcher as unknown as FSWatcher,
    });
    const applyGraphDelta = vi.spyOn(database, "applyGraphDelta");
    try {
      await indexer.start();
      watcher.emit("ready");
      await waitForReadyRevision(indexer, 1);
      applyGraphDelta.mockClear();

      await writeFile(
        join(root, "api.ts"),
        `import { service } from "@fixture/service"; export const api = () => service();\n`,
      );
      indexer.notifyPathChanged("api.ts", 0);
      await waitForReadyRevision(indexer, 2);

      const snapshot = indexer.graph.snapshot(500);
      const apiModule = snapshot.nodes.find(
        (node) => node.kind === "module" && node.relativePath === "api.ts",
      );
      const importEdge = snapshot.edges.find(
        (edge) =>
          edge.source === apiModule?.id && edge.relation === "imports",
      );
      expect(importEdge?.confidence).toBe("inferred");
      expect(
        snapshot.nodes.find((node) => node.id === importEdge?.target),
      ).toMatchObject({
        kind: "module",
        relativePath: "src/service.ts",
      });
      expect(applyGraphDelta).toHaveBeenCalledTimes(1);
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
      const provisionalSnapshots = snapshots.filter(
        (snapshot) => snapshot.provisional === true,
      );
      expect(snapshots[0]?.provisional).toBe(true);
      expect(snapshots[0]?.graph.nodes.length).toBeLessThanOrEqual(500);
      expect(snapshots[0]?.graph.truncated).toBe(true);
      expect(snapshots.every((snapshot) => snapshot.graph.nodes.length <= 500)).toBe(true);
      expect(provisionalSnapshots.length).toBeGreaterThan(2);
      expect(provisionalSnapshots[0]?.graph.nodes.length).toBeLessThan(
        provisionalSnapshots.at(-1)?.graph.nodes.length ?? 0,
      );
      expect(timeline.some((event) => event.type === "graph.delta")).toBe(false);

      const provisionalIndex = timeline.findIndex(
        (event) =>
          event.type === "graph.snapshot" &&
          (event.payload as { provisional?: boolean }).provisional === true,
      );
      const progressiveScanIndex = timeline.findIndex(
        (event) =>
          event.type === "index.progress" &&
          (event.payload as { phase?: string; completed?: number }).phase ===
            "scanning" &&
          ((event.payload as { completed?: number }).completed ?? 0) > 0,
      );
      const parsingIndex = timeline.findIndex(
        (event) =>
          event.type === "index.progress" &&
          (event.payload as { phase?: string }).phase === "parsing",
      );
      const readyIndex = timeline.findIndex(
        (event) =>
          event.type === "index.progress" &&
          (event.payload as { phase?: string }).phase === "ready",
      );
      expect(provisionalIndex).toBeGreaterThanOrEqual(0);
      expect(progressiveScanIndex).toBeGreaterThan(provisionalIndex);
      expect(parsingIndex).toBeGreaterThan(progressiveScanIndex);
      expect(readyIndex).toBeGreaterThan(provisionalIndex);
      expect(timeline[progressiveScanIndex]?.payload).toMatchObject({
        phase: "scanning",
        filesIndexed: expect.any(Number),
        symbolsIndexed: expect.any(Number),
        edgesIndexed: expect.any(Number),
      });
      const readyProgress = timeline.findLast(
        (event) =>
          event.type === "index.progress" &&
          (event.payload as { phase?: string }).phase === "ready",
      );
      expect(readyProgress?.payload).toMatchObject({
        revision: indexer.graph.revision,
        progress: 1,
        filesIndexed: indexer.indexedFileCount,
        symbolsIndexed: indexer.graph.nodeCount,
        edgesIndexed: indexer.graph.edgeCount,
      });
      expect(readyProgress?.payload).not.toHaveProperty("index");
    } finally {
      unsubscribe();
      await indexer.close();
      events.close();
      database.close();
    }
  }, 20_000);

  it("persists and reports aggregate source-memory truncation", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-index-budget-"));
    temporaryRoots.push(root);
    const first = "export const first = 1;\n";
    const second = "export const second = 2;\n";
    const third = "export const third = 3;\n";
    await writeFile(join(root, "a.ts"), first);
    await writeFile(join(root, "b.ts"), second);
    await writeFile(join(root, "c.ts"), third);

    const database = new ConstelixDatabase(":memory:");
    database.upsertWorkspace("workspace", root);
    const replaceIndexRevision = vi.spyOn(database, "replaceIndexRevision");
    const applyGraphDelta = vi.spyOn(database, "applyGraphDelta");
    const events = new EventBus();
    const timeline: Array<{ type: string; payload: unknown }> = [];
    const unsubscribe = events.subscribe((event) => {
      timeline.push({ type: event.type, payload: event.payload });
    });
    const watcher = createFakeWatcher();
    const budget = Buffer.byteLength(first) + Buffer.byteLength(second);
    const indexer = new WorkspaceIndexer("workspace", root, database, events, {
      watcherFactory: () => watcher as unknown as FSWatcher,
      scanOptions: {
        maxTotalBytes: budget,
        progressEveryFiles: 1,
      },
    });

    try {
      await indexer.start();
      watcher.emit("ready");
      await waitForReadyRevision(indexer, 1);

      const persisted = database.loadGraph("workspace");
      expect(persisted?.truncated).toBe(true);
      expect(
        persisted?.nodes.some((node) => node.relativePath === "c.ts"),
      ).toBe(false);
      expect(replaceIndexRevision.mock.calls.at(-1)?.[1].truncated).toBe(true);
      expect(indexer.status.message).toContain(
        `${budget} byte aggregate source-memory limit`,
      );
      const diagnostics = replaceIndexRevision.mock.calls.at(-1)?.[3] as
        | Array<{ relativePath?: string; message?: string }>
        | undefined;
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            relativePath: "c.ts",
            message: expect.stringContaining(
              "aggregate source-memory limit",
            ),
          }),
        ]),
      );
      const finalSnapshot = timeline.findLast(
        (event) =>
          event.type === "graph.snapshot" &&
          (event.payload as { provisional?: boolean }).provisional === false,
      );
      expect(finalSnapshot?.payload).toMatchObject({
        graph: { truncated: true },
        provisional: false,
      });

      replaceIndexRevision.mockClear();
      applyGraphDelta.mockClear();
      await writeFile(join(root, "a.ts"), "export const first = 9;\n");
      indexer.notifyPathChanged("a.ts", 0);
      await waitForReadyRevision(indexer, 2);

      expect(replaceIndexRevision).toHaveBeenCalledTimes(1);
      expect(applyGraphDelta).not.toHaveBeenCalled();
      expect(database.loadGraph("workspace")?.truncated).toBe(true);
    } finally {
      unsubscribe();
      await indexer.close();
      events.close();
      database.close();
    }
  }, 15_000);

  it("falls back before an incremental affected-source batch exceeds its memory budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-incremental-budget-"));
    temporaryRoots.push(root);
    const initial = "export const value = 1;\n";
    const importer =
      `import { value } from "./a"; export const result = value;\n`;
    const expanded = `${initial}${"// filler\n".repeat(20)}`;
    const budget =
      Buffer.byteLength(expanded) + Math.floor(Buffer.byteLength(importer) / 2);
    await writeFile(join(root, "a.ts"), initial);
    await writeFile(join(root, "b.ts"), importer);

    const database = new ConstelixDatabase(":memory:");
    database.upsertWorkspace("workspace", root);
    const replaceIndexRevision = vi.spyOn(database, "replaceIndexRevision");
    const applyGraphDelta = vi.spyOn(database, "applyGraphDelta");
    const events = new EventBus();
    const watcher = createFakeWatcher();
    const indexer = new WorkspaceIndexer("workspace", root, database, events, {
      watcherFactory: () => watcher as unknown as FSWatcher,
      scanOptions: { maxTotalBytes: budget },
    });

    try {
      await indexer.start();
      watcher.emit("ready");
      await waitForReadyRevision(indexer, 1);
      expect(database.loadGraph("workspace")?.truncated).toBe(false);
      replaceIndexRevision.mockClear();
      applyGraphDelta.mockClear();

      await writeFile(join(root, "a.ts"), expanded);
      indexer.notifyPathChanged("a.ts", 0);
      await waitForReadyRevision(indexer, 2);

      expect(applyGraphDelta).not.toHaveBeenCalled();
      expect(replaceIndexRevision).toHaveBeenCalledTimes(1);
      expect(database.loadGraph("workspace")?.truncated).toBe(true);
      expect(indexer.status.message).toContain(
        `${budget} byte aggregate source-memory limit`,
      );
      const audit = database.raw
        .prepare(
          `SELECT details_json
           FROM audit_events
           WHERE workspace_id = ? AND category = 'index'
             AND action = 'incremental' AND outcome = 'fallback'
           ORDER BY id DESC LIMIT 1`,
        )
        .get("workspace") as { details_json: string };
      expect(audit.details_json).toContain("aggregate source-memory limit");
    } finally {
      await indexer.close();
      events.close();
      database.close();
    }
  }, 15_000);

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
