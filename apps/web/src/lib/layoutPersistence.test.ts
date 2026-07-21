import { describe, expect, it } from "vitest";

import { graphRecordsToFlowNodes } from "./graph";
import {
  derivePinnedSemanticNodes,
  persistedPanelDock,
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
        dock: "right",
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
    expect(
      (layout.find((item) => item.id === "panel-editor") as { dock?: string })
        ?.dock,
    ).toBe("right");
    expect(layout.find((item) => item.id === "panel-editor")?.dockActive).toBe(
      true,
    );
  });

  it("persists one active tab independently for each dock", () => {
    const panels: WorkspaceNode[] = [
      {
        id: "panel-editor",
        type: "editorPanel",
        position: { x: 0, y: 0 },
        data: {
          panelType: "editor",
          dock: "right",
          title: "Editor",
          relativePath: "src/index.ts",
          language: "typescript",
          preview: "",
        },
        zIndex: 20,
      },
      {
        id: "panel-assistant",
        type: "assistantPanel",
        position: { x: 0, y: 0 },
        data: {
          panelType: "assistant",
          dock: "right",
          title: "Assistant",
          mode: "ask",
        },
        zIndex: 22,
      },
      {
        id: "panel-terminal",
        type: "terminalPanel",
        position: { x: 0, y: 0 },
        data: {
          panelType: "terminal",
          dock: "bottom",
          title: "Terminal",
          cwd: ".",
        },
        zIndex: 18,
      },
    ];
    const layout = serializeWorkspaceLayout({
      nodes: panels,
      assistantMode: "ask",
      collapsedNodeIds: {},
      pinnedSemanticNodeIds: {},
      updatedAt: "2026-07-18T00:00:00.000Z",
    });

    expect(layout.find(({ id }) => id === "panel-editor")?.dockActive).toBe(
      false,
    );
    expect(layout.find(({ id }) => id === "panel-assistant")?.dockActive).toBe(
      true,
    );
    expect(layout.find(({ id }) => id === "panel-terminal")?.dockActive).toBe(
      true,
    );
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

  it("migrates v0.0.3 layout records without dock to floating", () => {
    const legacy = serializeWorkspaceLayout({
      nodes: [semanticNode("legacy")],
      assistantMode: "ask",
      collapsedNodeIds: { legacy: true },
      pinnedSemanticNodeIds: {},
      updatedAt: "2026-07-16T00:00:00.000Z",
    })[0];
    if (!legacy) throw new Error("Expected layout record");
    const { dock: _dock, ...withoutDock } = legacy as typeof legacy & {
      dock?: string;
    };

    expect(persistedPanelDock(withoutDock)).toBe("floating");
  });
});
