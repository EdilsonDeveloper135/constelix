import type { GraphDelta } from "@constelix/contracts";

import { graphRecordsToFlowEdges, graphRecordsToFlowNodes } from "./graph";
import type { WorkspaceEdge, WorkspaceNode } from "../types";

export const MAX_VISIBLE_SEMANTIC_NODES = 500;

export type GraphDeltaMergeResult =
  | { kind: "duplicate"; revision: number; nodes: WorkspaceNode[]; edges: WorkspaceEdge[] }
  | { kind: "gap"; revision: number; nodes: WorkspaceNode[]; edges: WorkspaceEdge[] }
  | { kind: "applied"; revision: number; nodes: WorkspaceNode[]; edges: WorkspaceEdge[] };

export function mergeRevisionedGraphDelta(
  nodes: readonly WorkspaceNode[],
  edges: readonly WorkspaceEdge[],
  currentRevision: number,
  delta: GraphDelta,
): GraphDeltaMergeResult {
  if (delta.revision <= currentRevision) {
    return { kind: "duplicate", revision: currentRevision, nodes: [...nodes], edges: [...edges] };
  }
  if (delta.previousRevision !== currentRevision) {
    return { kind: "gap", revision: currentRevision, nodes: [...nodes], edges: [...edges] };
  }

  const removedNodeIds = new Set(delta.nodeIdsRemoved);
  const removedEdgeIds = new Set(delta.edgeIdsRemoved);
  const incomingNodes = new Map(
    [...delta.nodesAdded, ...delta.nodesUpdated]
      .map((record) => graphRecordsToFlowNodes([record])[0])
      .filter((node): node is WorkspaceNode => node !== undefined)
      .map((node) => [node.id, node]),
  );
  const incomingEdges = new Map(
    [...delta.edgesAdded, ...delta.edgesUpdated]
      .map((record) => graphRecordsToFlowEdges([record])[0])
      .filter((edge): edge is WorkspaceEdge => edge !== undefined)
      .map((edge) => [edge.id, edge]),
  );

  const nodeMap = new Map<string, WorkspaceNode>();
  for (const node of nodes) {
    if (removedNodeIds.has(node.id)) continue;
    const incoming = incomingNodes.get(node.id);
    if (incoming && node.type === "semantic" && incoming.type === "semantic") {
      nodeMap.set(node.id, {
        ...incoming,
        position: node.position,
        ...(node.hidden !== undefined ? { hidden: node.hidden } : {}),
        data: {
          ...incoming.data,
          ...(node.data.childCount !== undefined ? { childCount: node.data.childCount } : {}),
          ...(node.data.expanded !== undefined ? { expanded: node.data.expanded } : {}),
          ...(node.data.collapsed !== undefined ? { collapsed: node.data.collapsed } : {}),
          ...(node.data.hasMore !== undefined ? { hasMore: node.data.hasMore } : {}),
          ...(node.data.collapsedHidden !== undefined
            ? { collapsedHidden: node.data.collapsedHidden }
            : {}),
          ...(node.data.capacityHidden !== undefined
            ? { capacityHidden: node.data.capacityHidden }
            : {}),
        },
      });
    } else {
      nodeMap.set(node.id, node);
    }
    incomingNodes.delete(node.id);
  }
  for (const node of incomingNodes.values()) nodeMap.set(node.id, node);

  const edgeMap = new Map<string, WorkspaceEdge>();
  for (const edge of edges) {
    if (removedEdgeIds.has(edge.id)) continue;
    edgeMap.set(edge.id, incomingEdges.get(edge.id) ?? edge);
    incomingEdges.delete(edge.id);
  }
  for (const edge of incomingEdges.values()) edgeMap.set(edge.id, edge);

  const validNodeIds = new Set(nodeMap.keys());
  const mergedEdges = [...edgeMap.values()].filter(
    (edge) => validNodeIds.has(edge.source) && validNodeIds.has(edge.target),
  );
  return {
    kind: "applied",
    revision: delta.revision,
    nodes: [...nodeMap.values()],
    edges: mergedEdges,
  };
}

export function applySemanticViewState(
  nodes: readonly WorkspaceNode[],
  edges: readonly WorkspaceEdge[],
  collapsedNodeIds: ReadonlySet<string>,
  expansionCursors: Readonly<Record<string, string | null>>,
  forcedVisibleNodeIds: ReadonlySet<string> = new Set(),
): WorkspaceNode[] {
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.data?.relation !== "contains") continue;
    const existing = children.get(edge.source) ?? [];
    existing.push(edge.target);
    children.set(edge.source, existing);
  }

  const collapsedHidden = new Set<string>();
  const queue = [...collapsedNodeIds];
  for (let index = 0; index < queue.length; index += 1) {
    const parentId = queue[index];
    if (!parentId) continue;
    for (const childId of children.get(parentId) ?? []) {
      if (collapsedHidden.has(childId)) continue;
      collapsedHidden.add(childId);
      queue.push(childId);
    }
  }

  const semanticNodes = nodes.filter((node) => node.type === "semantic");
  const eligible = semanticNodes.filter(
    (node) => !collapsedHidden.has(node.id) || forcedVisibleNodeIds.has(node.id),
  );
  const forced = eligible
    .filter((node) => forcedVisibleNodeIds.has(node.id))
    .slice(0, MAX_VISIBLE_SEMANTIC_NODES);
  const regularCapacity = Math.max(
    0,
    MAX_VISIBLE_SEMANTIC_NODES - forced.length,
  );
  const capacityVisibleIds = new Set([
    ...forced.map((node) => node.id),
    ...eligible
      .filter((node) => !forcedVisibleNodeIds.has(node.id))
      .slice(0, regularCapacity)
      .map((node) => node.id),
  ]);

  return nodes.map((node) => {
    if (node.type !== "semantic") return node;
    const isCollapsedHidden =
      collapsedHidden.has(node.id) && !forcedVisibleNodeIds.has(node.id);
    const isCapacityHidden = !isCollapsedHidden && !capacityVisibleIds.has(node.id);
    const childCount = children.get(node.id)?.length ?? 0;
    const collapsed = collapsedNodeIds.has(node.id);
    return {
      ...node,
      hidden: isCollapsedHidden || isCapacityHidden,
      data: {
        ...node.data,
        childCount,
        collapsed,
        expanded: childCount > 0 && !collapsed,
        hasMore: typeof expansionCursors[node.id] === "string",
        collapsedHidden: isCollapsedHidden,
        capacityHidden: isCapacityHidden,
      },
    };
  }) as WorkspaceNode[];
}

export function hasCapacityHiddenNodes(nodes: readonly WorkspaceNode[]): boolean {
  return nodes.some(
    (node) => node.type === "semantic" && node.data.capacityHidden === true,
  );
}
