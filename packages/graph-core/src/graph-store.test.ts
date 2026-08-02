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
    confidence: "inferred",
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

  it("pages the complete graph when no roots or filters are supplied", () => {
    const store = new InMemoryGraphStore(snapshot());
    const first = store.query({
      protocolVersion: PROTOCOL_VERSION,
      rootIds: [],
      direction: "outbound",
      relations: [],
      nodeKinds: [],
      depth: 12,
      limit: 2,
    });
    const second = store.query({
      protocolVersion: PROTOCOL_VERSION,
      rootIds: [],
      direction: "outbound",
      relations: [],
      nodeKinds: [],
      depth: 12,
      limit: 2,
      cursor: first.cursor,
    });

    expect(first.nodes).toHaveLength(2);
    expect(first.truncated).toBe(true);
    expect(second.nodes).toHaveLength(2);
    expect(new Set([...first.nodes, ...second.nodes].map((node) => node.id)).size).toBe(4);
    const firstPageIds = new Set(first.nodes.map((node) => node.id));
    for (const edge of first.edges) {
      expect(firstPageIds.has(edge.source) && firstPageIds.has(edge.target)).toBe(true);
    }
    const secondPageIds = new Set(second.nodes.map((node) => node.id));
    for (const edge of second.edges) {
      expect(secondPageIds.has(edge.source) && secondPageIds.has(edge.target)).toBe(true);
    }
  });

  it("preserves source truncation through snapshots, queries and deltas", () => {
    const source = { ...snapshot(1), truncated: true };
    const store = new InMemoryGraphStore(source);

    const first = store.snapshot(2);
    const last = store.snapshot(2, first.cursor);
    expect(first).toMatchObject({ truncated: true, cursor: "v1:2" });
    expect(last.truncated).toBe(true);
    expect(last.cursor).toBeUndefined();

    const firstQueryPage = store.query({
      protocolVersion: PROTOCOL_VERSION,
      rootIds: [],
      direction: "outbound",
      relations: [],
      nodeKinds: [],
      depth: 4,
      limit: 2,
    });
    const lastQueryPage = store.query({
      protocolVersion: PROTOCOL_VERSION,
      rootIds: [],
      direction: "outbound",
      relations: [],
      nodeKinds: [],
      depth: 4,
      limit: 2,
      cursor: firstQueryPage.cursor,
    });
    expect(lastQueryPage.truncated).toBe(true);
    expect(lastQueryPage.cursor).toBeUndefined();

    const root = source.nodes.find((item) => item.kind === "project")!;
    const query = store.query({
      protocolVersion: PROTOCOL_VERSION,
      rootIds: [root.id],
      direction: "outbound",
      relations: [],
      nodeKinds: [],
      depth: 4,
      limit: 500,
    });
    expect(query.truncated).toBe(true);
    expect(query.cursor).toBeUndefined();

    store.applyDelta(diffSnapshots(source, { ...snapshot(2), truncated: true }));
    expect(store.snapshot(500)).toMatchObject({
      revision: 2,
      truncated: true,
    });

    store.replace(snapshot(3));
    expect(store.snapshot(500).truncated).toBe(false);
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

  it("returns deterministic multi-hop neighbors up to the requested depth", () => {
    const source = snapshot();
    const store = new InMemoryGraphStore(source);
    const root = source.nodes.find((item) => item.name === "root")!;

    const oneHop = store.neighbors(root.id, { direction: "outbound", depth: 1 });
    const threeHops = store.neighbors(root.id, { direction: "outbound", depth: 3 });

    expect(oneHop.nodes.map((item) => item.name)).toEqual(["api"]);
    expect(oneHop.edges).toHaveLength(1);
    expect(threeHops.nodes.map((item) => item.name)).toEqual(["api", "service", "database"]);
    expect(threeHops.edges).toHaveLength(3);
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
