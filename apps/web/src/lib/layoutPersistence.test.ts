import { describe, expect, it } from "vitest";

import { graphRecordsToFlowNodes } from "./graph";
import {
  derivePinnedSemanticNodes,
  serializeWorkspaceLayout,
} from "./layoutPersistence";
import type { WorkspaceNode } from "../types";

function semanticNode(id: string): WorkspaceNode {
  const node = graphRecordsToFlowNodes([{
    protocolVersion: 1,
    id,
    kind: "file",
    name: id,
    qualifiedName: id,
    relativePath: `${id}.ts`,
    language: "typescript",
    revision: 1,
    metadata: {},
  }])[0];
  if (!node) throw new Error("Expected semantic node");
  return node;
}

describe("workspace layout persistence", () => {
  it("persists tool panels plus only pinned or collapsed semantic nodes", () => {
    const editor: WorkspaceNode = {
      id: "panel-editor",
      type: "editorPanel",
      position: { x: 20, y: 30 },
      style: { width: 480, height: 320 },
      data: {
        panelType: "editor",
        title: "Editor",
        relativePath: "src/index.ts",
        language: "typescript",
        preview: "",
      },
    };
    const layout = serializeWorkspaceLayout({
      nodes: [
        semanticNode("ordinary"),
        semanticNode("pinned"),
        semanticNode("collapsed"),
        editor,
      ],
      assistantMode: "ask",
      collapsedNodeIds: { collapsed: true },
      pinnedSemanticNodeIds: { pinned: true },
      updatedAt: "2026-07-16T00:00:00.000Z",
    });

    expect(layout.map((item) => item.id)).toEqual([
      "pinned",
      "collapsed",
      "panel-editor",
    ]);
    expect(layout.find((item) => item.id === "pinned")?.pinned).toBe(true);
    expect(layout.find((item) => item.id === "collapsed")?.pinned).toBe(false);
  });

  it("hydrates pinning only from pinned semantic layout records", () => {
    const serialized = serializeWorkspaceLayout({
      nodes: [semanticNode("pinned"), semanticNode("collapsed")],
      assistantMode: "ask",
      collapsedNodeIds: { collapsed: true },
      pinnedSemanticNodeIds: { pinned: true },
      updatedAt: "2026-07-16T00:00:00.000Z",
    });

    expect(derivePinnedSemanticNodes(serialized)).toEqual({ pinned: true });
  });
});
