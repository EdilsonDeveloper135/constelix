import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type GraphEdge, type GraphNode, type GraphSnapshot } from "@constelix/contracts";
import { InMemoryGraphStore, createEdgeId, createNodeId, diffSnapshots, stableId } from "./index.js";

const workspaceId = "fixture";

function node(name: string, kind: GraphNode["kind"] = "file"): GraphNode {
  return {
    protocolVersion: PROTOCOL_VERSION,
    id: createNodeId(workspaceId, kind, `${name}.ts`, name),
    kind,
    name,
    qualifiedName: name,
    relativePath: `${name}.ts`,
    language: "typescript",
    revision: 1,
    metadata: {}
  };
}

function edge(source: GraphNode, target: GraphNode, relation: GraphEdge["relation"] = "imports"): GraphEdge {
  return {
    protocolVersion: PROTOCOL_VERSION,
    id: createEdgeId(source.id, relation, target.id),
    source: source.id,
    target: target.id,
    relation,
    confidence: "resolved",
    evidence: [],
    revision: 1,
    metadata: {}
  };
}

function snapshot(revision = 1): GraphSnapshot {
  const root = node("root", "project");
  const api = node("api");
  const service = node("service");
  const database = node("database");
  return {
    protocolVersion: PROTOCOL_VERSION,
    workspaceId,
    revision,
    nodes: [root, api, service, database],
    edges: [edge(root, api, "contains"), edge(api, service), edge(service, database, "calls")],
    truncated: false
  };
}

describe("stable graph IDs", () => {
  it("normalizes separators and Unicode", () => {
    expect(stableId("file", "src\\café.ts")).toBe(stableId("file", "src/cafe\u0301.ts"));
    expect(stableId("file", "ab", "c")).not.toBe(stableId("file", "a", "bc"));
  });
});

describe("InMemoryGraphStore", () => {
  it("builds the initial snapshot from a connected project root", () => {
    const store = new InMemoryGraphStore(snapshot());
    const result = store.snapshot(2);

    expect(result.nodes.map((item) => item.name)).toEqual(["root", "api"]);
    expect(result.edges).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("queries a bounded BFS subgraph", () => {
    const source = snapshot();
    const store = new InMemoryGraphStore(source);
    const root = source.nodes.find((item) => item.kind === "project");
    expect(root).toBeDefined();

    const result = store.query({
      protocolVersion: PROTOCOL_VERSION,
      rootIds: [root!.id],
      direction: "outbound",
      relations: [],
      nodeKinds: [],
      depth: 2,
      limit: 200
    });

    expect(result.nodes.map((item) => item.name).sort()).toEqual(["api", "root", "service"]);
    expect(result.edges).toHaveLength(2);
  });

  it("keeps the requested root on cursor pages", () => {
    const source = snapshot();
    const root = source.nodes.find((item) => item.kind === "project")!;
    const children = source.nodes.filter((item) => item.id !== root.id);
    source.edges = children.map((child) => edge(root, child, "contains"));
    const store = new InMemoryGraphStore(source);

    const first = store.query({
      protocolVersion: PROTOCOL_VERSION,
      rootIds: [root.id],
      direction: "outbound",
      relations: [],
      nodeKinds: [],
      depth: 1,
      limit: 2
    });
    const second = store.query({
      protocolVersion: PROTOCOL_VERSION,
      rootIds: [root.id],
      direction: "outbound",
      relations: [],
      nodeKinds: [],
      depth: 1,
      limit: 2,
      cursor: first.cursor
    });

    expect(first.nodes[0]?.id).toBe(root.id);
    expect(second.nodes[0]?.id).toBe(root.id);
    expect(first.edges).toHaveLength(1);
    expect(second.edges).toHaveLength(1);
  });

  it("returns evidence in shortest-path order", () => {
    const source = snapshot();
    const store = new InMemoryGraphStore(source);
    const root = source.nodes.find((item) => item.name === "root")!;
    const database = source.nodes.find((item) => item.name === "database")!;

    const path = store.shortestPath(root.id, database.id, { direction: "outbound" });

    expect(path?.nodeIds).toHaveLength(4);
    expect(path?.edgeIds).toHaveLength(3);
  });

  it("searches names, qualified names and paths with deterministic ranking", () => {
    const store = new InMemoryGraphStore(snapshot());
    expect(store.search("service")[0]?.name).toBe("service");
  });

  it("applies a snapshot delta transactionally", () => {
    const before = snapshot(1);
    const after = snapshot(2);
    const service = after.nodes.find((item) => item.name === "service")!;
    service.metadata = { changed: true };
    const delta = diffSnapshots(before, after);
    const store = new InMemoryGraphStore(before);

    store.applyDelta(delta);

    expect(store.revision).toBe(2);
    expect(store.getNode(service.id)?.metadata).toEqual({ changed: true });
  });

  it("rejects deltas based on a stale revision", () => {
    const before = snapshot(1);
    const store = new InMemoryGraphStore(before);
    const delta = diffSnapshots(before, snapshot(2));
    store.applyDelta(delta);
    expect(() => store.applyDelta(delta)).toThrow(/revision mismatch/i);
  });
});
