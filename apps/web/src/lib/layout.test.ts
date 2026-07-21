import { describe, expect, it, vi } from "vitest";

vi.mock("elkjs/lib/elk-api.js", () => ({
  default: class MockElk {
    async layout(): Promise<{ children: [] }> {
      return { children: [] };
    }
  },
}));

import { resolveSemanticLayoutCollisions } from "./layout";
import type { WorkspaceNode } from "../types";

describe("semantic layout collision resolution", () => {
  it("moves generated nodes away from panels and pinned semantic nodes", () => {
    const nodes = [
      semanticNode("pinned", 340, 88),
      semanticNode("generated-a", 0, 0),
      semanticNode("generated-b", 0, 0),
      editorPanel(340, 200),
    ];
    const result = resolveSemanticLayoutCollisions(
      nodes,
      {
        "generated-a": { x: 340, y: 88 },
        "generated-b": { x: 340, y: 88 },
      },
      new Set(["pinned"]),
    );

    expect(result["generated-a"]?.y).toBeGreaterThan(500);
    expect(result["generated-b"]?.y).toBeGreaterThan(
      result["generated-a"]?.y ?? 0,
    );
    expect(result).not.toHaveProperty("pinned");
  });

  it("returns deterministic positions for the same inputs", () => {
    const nodes = [
      semanticNode("b", 0, 0),
      semanticNode("a", 0, 0),
    ];
    const proposed = {
      a: { x: 400, y: 100 },
      b: { x: 400, y: 100 },
    };

    expect(
      resolveSemanticLayoutCollisions(nodes, proposed, new Set()),
    ).toEqual(resolveSemanticLayoutCollisions(nodes, proposed, new Set()));
  });
});

function semanticNode(id: string, x: number, y: number): WorkspaceNode {
  return {
    id,
    type: "semantic",
    position: { x, y },
    style: { width: 180, height: 52 },
    data: {
      kind: "file",
      label: id,
      relativePath: `${id}.ts`,
    },
  };
}

function editorPanel(x: number, y: number): WorkspaceNode {
  return {
    id: "panel-editor",
    type: "editorPanel",
    position: { x, y },
    style: { width: 480, height: 300 },
    data: {
      panelType: "editor",
      dock: "floating",
      title: "Editor",
      relativePath: "src/index.ts",
      language: "typescript",
      preview: "",
    },
  };
}
