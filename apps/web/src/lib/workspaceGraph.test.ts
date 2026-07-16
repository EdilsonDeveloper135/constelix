import { describe, expect, it } from "vitest";
import type { GraphDelta, GraphEdge, GraphNode } from "@constelix/contracts";

import {
  applySemanticViewState,
  MAX_VISIBLE_SEMANTIC_NODES,
  mergeGraphSnapshotPage,
  mergeRevisionedGraphDelta,
} from "./workspaceGraph";
import { graphRecordsToFlowEdges, graphRecordsToFlowNodes } from "./graph";

const node = (id: string, revision = 1): GraphNode => ({
  protocolVersion: 1,
  id,
  kind: "file",
  name: id,
  qualifiedName: id,
  relativePath: `${id}.ts`,
  language: "typescript",
  revision,
  metadata: {},
});

const edge = (id: string, source: string, target: string): GraphEdge => ({
  protocolVersion: 1,
  id,
  source,
  target,
  relation: "contains",
  confidence: "extracted",
  evidence: [],
  revision: 1,
  metadata: {},
});

const delta = (patch: Partial<GraphDelta>): GraphDelta => ({
  protocolVersion: 1,
  workspaceId: "workspace",
  previousRevision: 1,
  revision: 2,
  nodesAdded: [],
  nodesUpdated: [],
  nodeIdsRemoved: [],
  edgesAdded: [],
  edgesUpdated: [],
  edgeIdsRemoved: [],
  ...patch,
});

describe("revisioned frontend graph", () => {
  it("ignores duplicate deltas and detects revision gaps", () => {
    const nodes = graphRecordsToFlowNodes([node("one")]);
    expect(mergeRevisionedGraphDelta(nodes, [], 2, delta({ revision: 2 })).kind).toBe("duplicate");
    expect(mergeRevisionedGraphDelta(nodes, [], 1, delta({ previousRevision: 0, revision: 3 })).kind).toBe("gap");
  });

  it("merges additions idempotently by node and edge id", () => {
    const nodes = graphRecordsToFlowNodes([node("one")]);
    const edges = graphRecordsToFlowEdges([]);
    const change = delta({ nodesAdded: [node("two", 2)] });
    const first = mergeRevisionedGraphDelta(nodes, edges, 1, change);
    expect(first.kind).toBe("applied");
    if (first.kind !== "applied") return;
    const duplicate = mergeRevisionedGraphDelta(first.nodes, first.edges, first.revision, change);
    expect(duplicate.nodes.filter((item) => item.id === "two")).toHaveLength(1);
  });

  it("accumulates graph pages and retains cross-page edges", () => {
    const firstNodes = graphRecordsToFlowNodes([node("one")]);
    const result = mergeGraphSnapshotPage(firstNodes, [], {
      protocolVersion: 1,
      workspaceId: "workspace",
      revision: 1,
      nodes: [node("two")],
      edges: [edge("one-to-two", "one", "two")],
      truncated: false,
    });

    expect(result.nodes.map((item) => item.id)).toEqual(["one", "two"]);
    expect(result.edges.map((item) => item.id)).toEqual(["one-to-two"]);
    expect([...result.addedNodeIds]).toEqual(["two"]);
  });

  it("caps visible semantic nodes and collapses contains descendants", () => {
    const records = Array.from(
      { length: MAX_VISIBLE_SEMANTIC_NODES + 3 },
      (_, index) => node(`node-${index}`),
    );
    const contains = graphRecordsToFlowEdges([edge("contains", "node-0", "node-1")]);
    const visible = applySemanticViewState(
      graphRecordsToFlowNodes(records),
      contains,
      new Set(["node-0"]),
      {},
    );
    expect(visible.find((item) => item.id === "node-1")?.hidden).toBe(true);
    expect(
      visible.filter((item) => item.type === "semantic" && !item.hidden),
    ).toHaveLength(MAX_VISIBLE_SEMANTIC_NODES);
  });

  it("keeps evidence nodes visible through collapse and capacity culling", () => {
    const records = Array.from(
      { length: MAX_VISIBLE_SEMANTIC_NODES + 3 },
      (_, index) => node(`node-${index}`),
    );
    const contains = graphRecordsToFlowEdges([edge("contains", "node-0", "node-1")]);
    const forcedId = `node-${MAX_VISIBLE_SEMANTIC_NODES + 2}`;
    const visible = applySemanticViewState(
      graphRecordsToFlowNodes(records),
      contains,
      new Set(["node-0"]),
      {},
      new Set(["node-1", forcedId]),
    );

    expect(visible.find((item) => item.id === "node-1")?.hidden).toBe(false);
    expect(visible.find((item) => item.id === forcedId)?.hidden).toBe(false);
    expect(
      visible.filter((item) => item.type === "semantic" && !item.hidden),
    ).toHaveLength(MAX_VISIBLE_SEMANTIC_NODES);
  });
});
