import {
  EvidencePathSchema,
  GraphDeltaSchema,
  GraphQuerySchema,
  GraphSnapshotSchema,
  PROTOCOL_VERSION,
  type EvidencePath,
  type GraphDelta,
  type GraphDirection,
  type GraphEdge,
  type GraphNode,
  type GraphNodeKind,
  type GraphQuery,
  type GraphRelation,
  type GraphSnapshot
} from "@constelix/contracts";

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

function canonicalPart(part: string): string {
  return part.normalize("NFC").replaceAll("\\", "/");
}

/** Deterministic, platform-independent ID suitable for persisted graph entities. */
export function stableId(namespace: string, ...parts: readonly string[]): string {
  const canonical = parts.map((part) => {
    const value = canonicalPart(part);
    return `${new TextEncoder().encode(value).byteLength}:${value}`;
  }).join("|");
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(canonical)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & UINT64_MASK;
  }
  const prefix = namespace.toLowerCase().replace(/[^a-z0-9_-]+/g, "_") || "id";
  return `${prefix}_${hash.toString(16).padStart(16, "0")}`;
}

export function createNodeId(
  workspaceId: string,
  kind: GraphNodeKind,
  relativePath: string,
  qualifiedName = ""
): string {
  return stableId(kind, workspaceId, relativePath, qualifiedName);
}

export function createEdgeId(
  source: string,
  relation: GraphRelation,
  target: string,
  discriminator = ""
): string {
  return stableId("edge", source, relation, target, discriminator);
}

export interface GraphSearchOptions {
  kinds?: readonly GraphNodeKind[];
  limit?: number;
}

export interface NeighborOptions extends GraphSearchOptions {
  direction?: GraphDirection;
  relations?: readonly GraphRelation[];
}

export interface NeighborResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ShortestPathOptions {
  direction?: GraphDirection;
  relations?: readonly GraphRelation[];
  maxDepth?: number;
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const match = /^v1:(\d+)$/.exec(cursor);
  if (match?.[1] === undefined) throw new Error("Invalid graph cursor");
  return Number.parseInt(match[1], 10);
}

function scoreNode(node: GraphNode, terms: readonly string[]): number {
  const name = node.name.toLocaleLowerCase();
  const qualified = node.qualifiedName.toLocaleLowerCase();
  const path = node.relativePath.toLocaleLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name === term) score += 100;
    else if (name.startsWith(term)) score += 50;
    else if (name.includes(term)) score += 25;
    if (qualified.includes(term)) score += 10;
    if (path.includes(term)) score += 5;
  }
  return score;
}

function comparableEntity(entity: GraphNode | GraphEdge): string {
  const { revision: _revision, ...rest } = entity;
  return stableSerialize(rest);
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`);
  return `{${entries.join(",")}}`;
}

export class InMemoryGraphStore {
  private workspaceIdValue: string;
  private revisionValue = 0;
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();
  private outbound = new Map<string, Set<string>>();
  private inbound = new Map<string, Set<string>>();

  constructor(workspace: string | GraphSnapshot) {
    if (typeof workspace === "string") {
      if (workspace.length === 0) throw new Error("workspaceId must not be empty");
      this.workspaceIdValue = workspace;
    } else {
      this.workspaceIdValue = workspace.workspaceId;
      this.replace(workspace);
    }
  }

  get workspaceId(): string {
    return this.workspaceIdValue;
  }

  get revision(): number {
    return this.revisionValue;
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  get edgeCount(): number {
    return this.edges.size;
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  getEdge(id: string): GraphEdge | undefined {
    return this.edges.get(id);
  }

  replace(input: GraphSnapshot): void {
    const snapshot = GraphSnapshotSchema.parse(input);
    this.assertIntegrity(snapshot.nodes, snapshot.edges);
    this.workspaceIdValue = snapshot.workspaceId;
    this.revisionValue = snapshot.revision;
    this.nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
    this.edges = new Map(snapshot.edges.map((edge) => [edge.id, edge]));
    this.rebuildAdjacency();
  }

  applyDelta(input: GraphDelta): void {
    const delta = GraphDeltaSchema.parse(input);
    if (delta.workspaceId !== this.workspaceIdValue) throw new Error("Graph delta belongs to another workspace");
    if (delta.previousRevision !== this.revisionValue) {
      throw new Error(`Graph revision mismatch: expected ${this.revisionValue}, received ${delta.previousRevision}`);
    }
    if (delta.revision <= delta.previousRevision) throw new Error("Graph delta revision must advance");

    const nodes = new Map(this.nodes);
    const edges = new Map(this.edges);
    for (const id of delta.edgeIdsRemoved) edges.delete(id);
    for (const id of delta.nodeIdsRemoved) nodes.delete(id);
    for (const node of [...delta.nodesAdded, ...delta.nodesUpdated]) nodes.set(node.id, node);
    for (const edge of [...delta.edgesAdded, ...delta.edgesUpdated]) edges.set(edge.id, edge);

    for (const [id, edge] of edges) {
      if (!nodes.has(edge.source) || !nodes.has(edge.target)) {
        if (delta.nodeIdsRemoved.includes(edge.source) || delta.nodeIdsRemoved.includes(edge.target)) edges.delete(id);
      }
    }
    this.assertIntegrity([...nodes.values()], [...edges.values()]);
    this.nodes = nodes;
    this.edges = edges;
    this.revisionValue = delta.revision;
    this.rebuildAdjacency();
  }

  snapshot(limit = 500, cursor?: string): GraphSnapshot {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const offset = parseCursor(cursor);
    const ordered = this.connectedNodeOrder();
    const nodes = ordered.slice(offset, offset + boundedLimit);
    const included = new Set(nodes.map((node) => node.id));
    const edges = [...this.edges.values()]
      .filter((edge) => included.has(edge.source) && included.has(edge.target))
      .sort((left, right) => left.id.localeCompare(right.id));
    const nextOffset = offset + nodes.length;
    return GraphSnapshotSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      workspaceId: this.workspaceIdValue,
      revision: this.revisionValue,
      nodes,
      edges,
      truncated: nextOffset < ordered.length,
      ...(nextOffset < ordered.length ? { cursor: `v1:${nextOffset}` } : {})
    });
  }

  query(input: GraphQuery): GraphSnapshot {
    const query = GraphQuerySchema.parse(input);
    const relationSet = new Set(query.relations);
    const roots = query.rootIds.length > 0
      ? query.rootIds.filter((id) => this.nodes.has(id))
      : this.defaultRootIds();
    const visited = new Set<string>();
    const traversedEdges = new Set<string>();
    const queue = roots.map((id) => ({ id, depth: 0 }));

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || visited.has(current.id)) continue;
      visited.add(current.id);
      if (current.depth >= query.depth) continue;
      for (const edge of this.adjacentEdges(current.id, query.direction)) {
        if (relationSet.size > 0 && !relationSet.has(edge.relation)) continue;
        traversedEdges.add(edge.id);
        const next = edge.source === current.id ? edge.target : edge.source;
        if (!visited.has(next)) queue.push({ id: next, depth: current.depth + 1 });
      }
    }

    let candidates = [...visited]
      .map((id) => this.nodes.get(id))
      .filter((node): node is GraphNode => node !== undefined);
    if (query.nodeKinds.length > 0) {
      const kinds = new Set(query.nodeKinds);
      candidates = candidates.filter((node) => kinds.has(node.kind));
    }
    const search = query.search ?? "";
    const hasSearch = search.length > 0;
    if (hasSearch) {
      const terms = search.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      candidates = candidates
        .map((node) => ({ node, score: scoreNode(node, terms) }))
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id))
        .map(({ node }) => node);
    } else {
      const rank = new Map(this.connectedNodeOrder().map((node, index) => [node.id, index]));
      candidates.sort((left, right) => (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER));
    }

    const offset = parseCursor(query.cursor);
    const rootSet = new Set(roots);
    const pinnedRoots = hasSearch ? [] : candidates.filter((node) => rootSet.has(node.id));
    const pageable = hasSearch ? candidates : candidates.filter((node) => !rootSet.has(node.id));
    const pageLimit = Math.max(0, query.limit - pinnedRoots.length);
    const page = pageable.slice(offset, offset + pageLimit);
    const nodes = [...pinnedRoots, ...page];
    const included = new Set(nodes.map((node) => node.id));
    const edges = [...traversedEdges]
      .map((id) => this.edges.get(id))
      .filter((edge): edge is GraphEdge => edge !== undefined && included.has(edge.source) && included.has(edge.target))
      .sort((left, right) => left.id.localeCompare(right.id));
    const nextOffset = offset + page.length;
    return GraphSnapshotSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      workspaceId: this.workspaceIdValue,
      revision: this.revisionValue,
      nodes,
      edges,
      truncated: nextOffset < pageable.length,
      ...(nextOffset < pageable.length ? { cursor: `v1:${nextOffset}` } : {})
    });
  }

  search(text: string, options: GraphSearchOptions = {}): GraphNode[] {
    const terms = text.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const kindSet = new Set(options.kinds ?? []);
    const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 50)));
    return [...this.nodes.values()]
      .filter((node) => kindSet.size === 0 || kindSet.has(node.kind))
      .map((node) => ({ node, score: scoreNode(node, terms) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id))
      .slice(0, limit)
      .map(({ node }) => node);
  }

  neighbors(nodeId: string, options: NeighborOptions = {}): NeighborResult {
    if (!this.nodes.has(nodeId)) return { nodes: [], edges: [] };
    const direction = options.direction ?? "both";
    const relationSet = new Set(options.relations ?? []);
    const kindSet = new Set(options.kinds ?? []);
    const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
    const pairs: Array<{ node: GraphNode; edge: GraphEdge }> = [];
    for (const edge of this.adjacentEdges(nodeId, direction)) {
      if (relationSet.size > 0 && !relationSet.has(edge.relation)) continue;
      const otherId = edge.source === nodeId ? edge.target : edge.source;
      const node = this.nodes.get(otherId);
      if (node === undefined || (kindSet.size > 0 && !kindSet.has(node.kind))) continue;
      pairs.push({ node, edge });
    }
    pairs.sort((left, right) => left.node.id.localeCompare(right.node.id) || left.edge.id.localeCompare(right.edge.id));
    const selected = pairs.slice(0, limit);
    return {
      nodes: selected.map(({ node }) => node),
      edges: selected.map(({ edge }) => edge)
    };
  }

  shortestPath(sourceId: string, targetId: string, options: ShortestPathOptions = {}): EvidencePath | null {
    if (!this.nodes.has(sourceId) || !this.nodes.has(targetId)) return null;
    if (sourceId === targetId) {
      return EvidencePathSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        nodeIds: [sourceId],
        edgeIds: [],
        evidence: [],
        complete: true
      });
    }
    const direction = options.direction ?? "both";
    const relations = new Set(options.relations ?? []);
    const maxDepth = Math.max(1, Math.min(24, Math.trunc(options.maxDepth ?? 12)));
    const queue: Array<{ id: string; depth: number }> = [{ id: sourceId, depth: 0 }];
    const previous = new Map<string, { nodeId: string; edgeId: string }>();
    const visited = new Set([sourceId]);

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || current.depth >= maxDepth) continue;
      for (const edge of this.adjacentEdges(current.id, direction)) {
        if (relations.size > 0 && !relations.has(edge.relation)) continue;
        const next = edge.source === current.id ? edge.target : edge.source;
        if (visited.has(next)) continue;
        visited.add(next);
        previous.set(next, { nodeId: current.id, edgeId: edge.id });
        if (next === targetId) return this.buildPath(sourceId, targetId, previous);
        queue.push({ id: next, depth: current.depth + 1 });
      }
    }
    return null;
  }

  private buildPath(
    sourceId: string,
    targetId: string,
    previous: ReadonlyMap<string, { nodeId: string; edgeId: string }>
  ): EvidencePath {
    const nodeIds = [targetId];
    const edgeIds: string[] = [];
    let cursor = targetId;
    while (cursor !== sourceId) {
      const step = previous.get(cursor);
      if (step === undefined) throw new Error("Cannot reconstruct graph path");
      nodeIds.push(step.nodeId);
      edgeIds.push(step.edgeId);
      cursor = step.nodeId;
    }
    nodeIds.reverse();
    edgeIds.reverse();
    const evidence = edgeIds.flatMap((id) => this.edges.get(id)?.evidence ?? []);
    return EvidencePathSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      nodeIds,
      edgeIds,
      evidence,
      complete: true
    });
  }

  private defaultRootIds(): string[] {
    const projects = [...this.nodes.values()].filter((node) => node.kind === "project").map((node) => node.id).sort();
    if (projects.length > 0) return projects;
    return [...this.nodes.keys()].sort();
  }

  private connectedNodeOrder(): GraphNode[] {
    const visited = new Set<string>();
    const ordered: GraphNode[] = [];
    const queue = [...this.defaultRootIds()];
    const queued = new Set(queue);
    let queueIndex = 0;

    while (queueIndex < queue.length) {
      const id = queue[queueIndex++];
      if (id === undefined || visited.has(id)) continue;
      const node = this.nodes.get(id);
      if (node === undefined) continue;
      visited.add(id);
      ordered.push(node);

      const neighbors = this.adjacentEdges(id, "both")
        .map((edge) => edge.source === id ? edge.target : edge.source)
        .filter((neighborId) => !visited.has(neighborId))
        .sort((left, right) => left.localeCompare(right));
      for (const neighborId of neighbors) {
        if (!queued.has(neighborId)) {
          queue.push(neighborId);
          queued.add(neighborId);
        }
      }
    }

    for (const node of [...this.nodes.values()].sort((left, right) => left.id.localeCompare(right.id))) {
      if (!visited.has(node.id)) ordered.push(node);
    }
    return ordered;
  }

  private adjacentEdges(nodeId: string, direction: GraphDirection): GraphEdge[] {
    const ids = new Set<string>();
    if (direction !== "inbound") for (const id of this.outbound.get(nodeId) ?? []) ids.add(id);
    if (direction !== "outbound") for (const id of this.inbound.get(nodeId) ?? []) ids.add(id);
    return [...ids].map((id) => this.edges.get(id)).filter((edge): edge is GraphEdge => edge !== undefined);
  }

  private assertIntegrity(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): void {
    const nodeIds = new Set<string>();
    for (const node of nodes) {
      if (nodeIds.has(node.id)) throw new Error(`Duplicate graph node: ${node.id}`);
      nodeIds.add(node.id);
    }
    const edgeIds = new Set<string>();
    for (const edge of edges) {
      if (edgeIds.has(edge.id)) throw new Error(`Duplicate graph edge: ${edge.id}`);
      edgeIds.add(edge.id);
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
        throw new Error(`Dangling graph edge: ${edge.id}`);
      }
    }
  }

  private rebuildAdjacency(): void {
    this.outbound = new Map();
    this.inbound = new Map();
    for (const edge of this.edges.values()) {
      const outgoing = this.outbound.get(edge.source) ?? new Set<string>();
      outgoing.add(edge.id);
      this.outbound.set(edge.source, outgoing);
      const incoming = this.inbound.get(edge.target) ?? new Set<string>();
      incoming.add(edge.id);
      this.inbound.set(edge.target, incoming);
    }
  }
}

/** Creates a minimal, idempotent delta between two complete graph revisions. */
export function diffSnapshots(previousInput: GraphSnapshot, nextInput: GraphSnapshot): GraphDelta {
  const previous = GraphSnapshotSchema.parse(previousInput);
  const next = GraphSnapshotSchema.parse(nextInput);
  if (previous.workspaceId !== next.workspaceId) throw new Error("Cannot diff snapshots from different workspaces");
  if (next.revision <= previous.revision) throw new Error("The next graph snapshot must advance the revision");
  const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  const nextNodes = new Map(next.nodes.map((node) => [node.id, node]));
  const previousEdges = new Map(previous.edges.map((edge) => [edge.id, edge]));
  const nextEdges = new Map(next.edges.map((edge) => [edge.id, edge]));

  return GraphDeltaSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    workspaceId: next.workspaceId,
    previousRevision: previous.revision,
    revision: next.revision,
    nodesAdded: next.nodes.filter((node) => !previousNodes.has(node.id)),
    nodesUpdated: next.nodes.filter((node) => {
      const old = previousNodes.get(node.id);
      return old !== undefined && comparableEntity(old) !== comparableEntity(node);
    }),
    nodeIdsRemoved: previous.nodes.filter((node) => !nextNodes.has(node.id)).map((node) => node.id),
    edgesAdded: next.edges.filter((edge) => !previousEdges.has(edge.id)),
    edgesUpdated: next.edges.filter((edge) => {
      const old = previousEdges.get(edge.id);
      return old !== undefined && comparableEntity(old) !== comparableEntity(edge);
    }),
    edgeIdsRemoved: previous.edges.filter((edge) => !nextEdges.has(edge.id)).map((edge) => edge.id)
  });
}
