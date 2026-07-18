import { describe, expect, it } from "vitest";

import {
  applyCanvasFilters,
  availableExtensions,
  nodeExtension,
} from "./canvasFilters";
import type {
  SemanticNodeKind,
  WorkspaceEdge,
  WorkspaceNode,
} from "../types";

describe("canvas filters", () => {
  it("derives sorted extensions from semantic nodes only", () => {
    const nodes = [
      semanticNode("ts", "file", "src/index.TS"),
      semanticNode("py", "file", "service.py"),
      semanticNode("hidden", "function", "src/index.ts"),
      editorPanel(),
    ];

    expect(nodeExtension(nodes[0] as Extract<WorkspaceNode, { type: "semantic" }>))
      .toBe(".ts");
    expect(availableExtensions(nodes)).toEqual([".py", ".ts"]);
  });

  it("filters semantic nodes and removes edges whose endpoints are hidden", () => {
    const nodes = [
      semanticNode("workspace", "workspace"),
      semanticNode("ts-file", "file", "src/index.ts"),
      semanticNode("py-file", "file", "service.py"),
      editorPanel(),
    ];
    const edges = [
      edge("workspace-ts", "workspace", "ts-file"),
      edge("workspace-py", "workspace", "py-file"),
    ];

    const result = applyCanvasFilters(nodes, edges, {
      nodeKind: "file",
      extension: ".ts",
    });

    expect(visibleIds(result.nodes)).toEqual(["ts-file", "panel-editor"]);
    expect(result.edges).toEqual([]);
    expect(nodes.every((node) => node.hidden === undefined)).toBe(true);
  });

  it("keeps verified evidence visible even when it falls outside the filter", () => {
    const nodes = [
      semanticNode("ts-file", "file", "src/index.ts"),
      semanticNode("py-file", "file", "service.py"),
    ];
    const result = applyCanvasFilters(
      nodes,
      [edge("dependency", "ts-file", "py-file")],
      { nodeKind: "all", extension: ".ts" },
      new Set(["py-file"]),
    );

    expect(visibleIds(result.nodes)).toEqual(["ts-file", "py-file"]);
    expect(result.edges).toHaveLength(1);
    expect(result.evidenceOverrides).toBe(1);
  });
});

function semanticNode(
  id: string,
  kind: SemanticNodeKind,
  relativePath?: string,
): WorkspaceNode {
  return {
    id,
    type: "semantic",
    position: { x: 0, y: 0 },
    data: {
      kind,
      label: id,
      ...(relativePath === undefined ? {} : { relativePath }),
    },
  };
}

function editorPanel(): WorkspaceNode {
  return {
    id: "panel-editor",
    type: "editorPanel",
    position: { x: 0, y: 0 },
    data: {
      panelType: "editor",
      title: "Editor",
      relativePath: "src/index.ts",
      language: "typescript",
      preview: "",
    },
  };
}

function edge(id: string, source: string, target: string): WorkspaceEdge {
  return {
    id,
    type: "graphEdge",
    source,
    target,
    data: {
      relation: "imports",
      confidence: "extracted",
    },
  };
}

function visibleIds(nodes: readonly WorkspaceNode[]): string[] {
  return nodes.filter((node) => !node.hidden).map((node) => node.id);
}
