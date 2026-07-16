import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConstelixDatabase } from "./database.js";
import type { GraphSnapshot, PanelState } from "@constelix/contracts";
import { diffSnapshots } from "@constelix/graph-core";

describe("ConstelixDatabase", () => {
  it("migrates, persists a graph, layout and conversation", () => {
    const database = new ConstelixDatabase(":memory:");
    database.upsertWorkspace("ws", "/tmp/workspace");
    const snapshot: GraphSnapshot = {
      protocolVersion: 1,
      workspaceId: "ws",
      revision: 1,
      nodes: [
        {
          protocolVersion: 1,
          id: "project",
          kind: "project",
          name: "workspace",
          qualifiedName: "workspace",
          relativePath: ".",
          language: "unknown",
          revision: 1,
          metadata: {},
        },
      ],
      edges: [],
      truncated: false,
    };
    database.replaceGraph("ws", snapshot);
    expect(database.loadGraph("ws")).toEqual(snapshot);

    const panel: PanelState = {
      protocolVersion: 1,
      id: "editor-1",
      kind: "editor",
      position: { x: 10, y: 20 },
      size: { width: 600, height: 400 },
      resource: { relativePath: "src/main.ts" },
      zoom: 1,
      pinned: false,
      updatedAt: "2026-07-16T00:00:00.000Z",
    };
    database.saveLayout("ws", 1, [panel]);
    expect(database.loadLayout("ws")).toEqual({ revision: 1, panels: [panel] });
    const stalePanel = {
      ...panel,
      position: { x: 1, y: 2 },
      updatedAt: "2026-07-15T23:59:59.000Z",
    };
    const freshPanel = {
      ...panel,
      position: { x: 30, y: 40 },
      updatedAt: "2026-07-16T00:00:01.000Z",
    };
    expect(database.saveLayout("ws", 2, [freshPanel])).toBe(true);
    expect(database.saveLayout("ws", 3, [stalePanel])).toBe(false);
    expect(database.loadLayout("ws")).toEqual({
      revision: 2,
      panels: [freshPanel],
    });

    database.appendAiMessage("ws", "thread", {
      id: "message",
      role: "user",
      content: "Where is main?",
    });
    expect(database.loadAiMessages("thread")).toEqual([
      { role: "user", content: "Where is main?" },
    ]);
    database.close();
  });

  it("applies graph and file deltas without rewriting unaffected rows", () => {
    const database = new ConstelixDatabase(":memory:");
    database.upsertWorkspace("ws", "/tmp/workspace");
    const initial: GraphSnapshot = {
      protocolVersion: 1,
      workspaceId: "ws",
      revision: 1,
      nodes: [
        {
          protocolVersion: 1,
          id: "project",
          kind: "project",
          name: "workspace",
          qualifiedName: "workspace",
          relativePath: "",
          language: "unknown",
          revision: 1,
          metadata: {},
        },
      ],
      edges: [],
      truncated: false,
    };
    database.replaceGraph("ws", initial);
    database.replaceFiles("ws", 1, []);

    const withFile: GraphSnapshot = {
      ...initial,
      revision: 2,
      nodes: [
        ...initial.nodes,
        {
          protocolVersion: 1,
          id: "file",
          kind: "file",
          name: "main.ts",
          qualifiedName: "main.ts",
          relativePath: "main.ts",
          language: "typescript",
          revision: 2,
          metadata: {},
        },
      ],
    };
    database.applyGraphDelta(
      "ws",
      diffSnapshots(initial, withFile),
      {
        upsert: [
          {
            relativePath: "main.ts",
            contentHash: "hash",
            sizeBytes: 10,
            mtimeMs: 123,
            language: "typescript",
          },
        ],
      },
      [{ message: "incremental" }],
    );

    expect(database.loadGraph("ws")).toEqual(withFile);
    expect(database.search("ws", "main")).toEqual(["file"]);
    expect(
      database.raw
        .prepare("SELECT revision FROM graph_nodes WHERE workspace_id = ? AND id = ?")
        .get("ws", "project"),
    ).toEqual({ revision: 1 });
    expect(
      database.raw
        .prepare("SELECT indexed_revision FROM files WHERE workspace_id = ? AND relative_path = ?")
        .get("ws", "main.ts"),
    ).toEqual({ indexed_revision: 2 });
    expect(() =>
      database.applyGraphDelta("ws", diffSnapshots(initial, withFile)),
    ).toThrow(/revision mismatch/i);

    const removed: GraphSnapshot = { ...initial, revision: 3 };
    database.applyGraphDelta(
      "ws",
      diffSnapshots(withFile, removed),
      { removedPaths: ["main.ts"] },
    );
    expect(database.loadGraph("ws")).toEqual(removed);
    expect(
      database.raw
        .prepare("SELECT COUNT(*) AS count FROM files WHERE workspace_id = ?")
        .get("ws"),
    ).toEqual({ count: 0 });
    database.close();
  });

  it("preserves source truncation across replacement, reload and incremental revisions", () => {
    const directory = mkdtempSync(join(tmpdir(), "constelix-database-truncation-"));
    const databasePath = join(directory, "constelix.sqlite");
    let database = new ConstelixDatabase(databasePath);
    try {
      database.upsertWorkspace("ws", "/tmp/workspace");
      const initial: GraphSnapshot = {
        protocolVersion: 1,
        workspaceId: "ws",
        revision: 1,
        nodes: [{
          protocolVersion: 1,
          id: "project",
          kind: "project",
          name: "workspace",
          qualifiedName: "workspace",
          relativePath: "",
          language: "unknown",
          revision: 1,
          metadata: {},
        }],
        edges: [],
        truncated: true,
      };
      database.replaceIndexRevision("ws", initial, []);
      database.close();

      database = new ConstelixDatabase(databasePath);
      expect(database.loadGraph("ws")).toEqual(initial);

      const next: GraphSnapshot = {
        ...initial,
        revision: 2,
      };
      database.applyGraphDelta("ws", diffSnapshots(initial, next));
      expect(database.loadGraph("ws")).toEqual(next);

      const complete = {
        ...next,
        revision: 3,
        truncated: false,
      };
      database.replaceGraph("ws", complete);
      expect(database.loadGraph("ws")).toEqual(complete);
    } finally {
      if (database.raw.open) database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("migrates legacy index revisions with a non-truncated default", () => {
    const directory = mkdtempSync(join(tmpdir(), "constelix-database-migration-"));
    const databasePath = join(directory, "constelix.sqlite");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations(version, applied_at)
        VALUES (1, '2026-07-16T00:00:00.000Z');
      CREATE TABLE index_revisions (
        workspace_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        diagnostics_json TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (workspace_id, revision)
      );
      INSERT INTO index_revisions(workspace_id, revision, created_at)
        VALUES ('ws', 1, '2026-07-16T00:00:00.000Z');
    `);
    legacy.close();

    const database = new ConstelixDatabase(databasePath);
    try {
      const columns = database.raw.pragma("table_info(index_revisions)") as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).toContain("truncated");
      expect(
        database.raw
          .prepare("SELECT truncated FROM index_revisions WHERE workspace_id = ?")
          .get("ws"),
      ).toEqual({ truncated: 0 });
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replaces a cold graph revision and file manifest atomically", () => {
    const database = new ConstelixDatabase(":memory:");
    database.upsertWorkspace("ws", "/tmp/workspace");
    const initial: GraphSnapshot = {
      protocolVersion: 1,
      workspaceId: "ws",
      revision: 1,
      nodes: [
        {
          protocolVersion: 1,
          id: "project",
          kind: "project",
          name: "workspace",
          qualifiedName: "workspace",
          relativePath: "",
          language: "unknown",
          revision: 1,
          metadata: {},
        },
      ],
      edges: [],
      truncated: false,
    };
    database.replaceIndexRevision("ws", initial, [
      {
        relativePath: "main.ts",
        contentHash: "before",
        sizeBytes: 10,
        mtimeMs: 1,
        language: "typescript",
      },
    ]);

    const next: GraphSnapshot = {
      ...initial,
      revision: 2,
      nodes: initial.nodes.map((node) => ({ ...node, revision: 2 })),
    };
    const duplicateFile = {
      relativePath: "duplicate.ts",
      contentHash: "after",
      sizeBytes: 20,
      mtimeMs: 2,
      language: "typescript",
    };
    expect(() =>
      database.replaceIndexRevision("ws", next, [duplicateFile, duplicateFile]),
    ).toThrow();

    expect(database.loadGraph("ws")?.revision).toBe(1);
    expect(database.loadFiles("ws")).toEqual([
      {
        relativePath: "main.ts",
        contentHash: "before",
        sizeBytes: 10,
        mtimeMs: 1,
        language: "typescript",
      },
    ]);
    database.close();
  });

  it("redacts graph secrets before SQLite persistence", () => {
    const database = new ConstelixDatabase(":memory:");
    database.upsertWorkspace("ws", "/tmp/workspace");
    const secret = "real-production-secret-12345";
    const snapshot: GraphSnapshot = {
      protocolVersion: 1,
      workspaceId: "ws",
      revision: 1,
      nodes: [
        {
          protocolVersion: 1,
          id: "function",
          kind: "function",
          name: "connect",
          qualifiedName: "src/config.connect",
          relativePath: "src/config.ts",
          language: "typescript",
          revision: 1,
          metadata: { signature: `function connect(api_key="${secret}")` },
        },
      ],
      edges: [],
      truncated: false,
    };

    database.replaceIndexRevision("ws", snapshot, [], [
      { message: `api_key=${secret}` },
    ]);

    const node = database.raw
      .prepare("SELECT data_json FROM graph_nodes WHERE workspace_id = ?")
      .get("ws") as { data_json: string };
    const revision = database.raw
      .prepare("SELECT diagnostics_json FROM index_revisions WHERE workspace_id = ?")
      .get("ws") as { diagnostics_json: string };
    expect(node.data_json).not.toContain(secret);
    expect(revision.diagnostics_json).not.toContain(secret);
    expect(node.data_json).toContain("[REDACTED]");
    database.close();
  });

  it("upgrades legacy resolved confidence values while loading v0.0.1 data", () => {
    const database = new ConstelixDatabase(":memory:");
    database.upsertWorkspace("ws", "/tmp/workspace");
    const snapshot: GraphSnapshot = {
      protocolVersion: 1,
      workspaceId: "ws",
      revision: 1,
      nodes: [
        {
          protocolVersion: 1,
          id: "source",
          kind: "module",
          name: "source",
          qualifiedName: "source",
          relativePath: "source.ts",
          language: "typescript",
          revision: 1,
          metadata: {},
        },
        {
          protocolVersion: 1,
          id: "target",
          kind: "module",
          name: "target",
          qualifiedName: "target",
          relativePath: "target.ts",
          language: "typescript",
          revision: 1,
          metadata: {},
        },
      ],
      edges: [{
        protocolVersion: 1,
        id: "import",
        source: "source",
        target: "target",
        relation: "imports",
        confidence: "inferred",
        evidence: [],
        revision: 1,
        metadata: {},
      }],
      truncated: false,
    };
    database.replaceGraph("ws", snapshot);
    const legacy = JSON.stringify({
      ...snapshot.edges[0],
      confidence: "resolved",
    });
    database.raw
      .prepare("UPDATE graph_edges SET data_json = ? WHERE workspace_id = ? AND id = ?")
      .run(legacy, "ws", "import");

    expect(database.loadGraph("ws")?.edges[0]?.confidence).toBe("inferred");
    database.close();
  });

  it("redacts AI, Codex and audit secrets at the SQLite boundary", () => {
    const database = new ConstelixDatabase(":memory:");
    database.upsertWorkspace("ws", "/tmp/workspace");
    const secret = ["sk", "proj", "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"].join("-");

    database.appendAiMessage("ws", "thread", {
      id: "message",
      role: "user",
      content: `api_key=${secret}`,
      evidence: { excerpt: `token=${secret}` },
    });
    database.saveCodexTask("ws", {
      id: "task",
      status: "pending_approval",
      objective: `Use api_key=${secret}`,
    });
    database.saveCodexTask("ws", {
      id: "resumable-task",
      status: "completed",
      codexThreadId: "thread-resumable",
    });
    database.audit("ws", "security", "persist", "success", {
      token: `api_key=${secret}`,
    });

    const aiMessage = database.raw
      .prepare("SELECT content,evidence_json FROM ai_messages WHERE id = ?")
      .get("message") as { content: string; evidence_json: string };
    const codexTask = database.raw
      .prepare("SELECT task_json FROM codex_threads WHERE id = ?")
      .get("task") as { task_json: string };
    const auditEvent = database.raw
      .prepare("SELECT details_json FROM audit_events WHERE workspace_id = ?")
      .get("ws") as { details_json: string };
    const persisted = JSON.stringify({ aiMessage, codexTask, auditEvent });

    expect(persisted).not.toContain(secret);
    expect(persisted).toContain("[REDACTED");
    expect(database.loadLatestCodexThreadId("ws")).toBe("thread-resumable");
    database.close();
  });
});
