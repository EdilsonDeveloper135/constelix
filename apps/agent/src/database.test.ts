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
      updatedAt: new Date().toISOString(),
    };
    database.saveLayout("ws", 1, [panel]);
    expect(database.loadLayout("ws")).toEqual({ revision: 1, panels: [panel] });

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
});
