import ELK from "elkjs/lib/elk-api.js";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";

import type { WorkspaceEdge, WorkspaceNode } from "../types";

const elk = new ELK({ workerUrl: elkWorkerUrl });
const GRAPH_ORIGIN = { x: 340, y: 88 };
const COLLISION_GAP = 28;

interface NodeSize {
  width: number;
  height: number;
}

interface Rect extends NodeSize {
  x: number;
  y: number;
}

function nodeSize(node: WorkspaceNode): NodeSize {
  const measuredWidth = node.measured?.width;
  const measuredHeight = node.measured?.height;
  const styleWidth =
    typeof node.style?.width === "number" ? node.style.width : undefined;
  const styleHeight =
    typeof node.style?.height === "number" ? node.style.height : undefined;
  if (node.type !== "semantic") {
    return {
      width: measuredWidth ?? styleWidth ?? 480,
      height: measuredHeight ?? styleHeight ?? 240,
    };
  }
  const labelLength = node.data.label.length;
  const detailLength = node.data.detail?.length ?? 0;
  return {
    width:
      measuredWidth ??
      Math.max(146, Math.min(260, 72 + Math.max(labelLength, detailLength) * 7)),
    height: measuredHeight ?? 52,
  };
}

export async function layoutSemanticNodes(
  nodes: readonly WorkspaceNode[],
  edges: readonly WorkspaceEdge[]
): Promise<Record<string, { x: number; y: number }>> {
  const semanticNodes = nodes.filter(
    (node) => node.type === "semantic" && !node.hidden,
  );
  const semanticIds = new Set(semanticNodes.map((node) => node.id));
  const graph = await elk.layout({
    id: "constelix",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "96",
      "elk.spacing.nodeNode": "58",
      "elk.spacing.componentComponent": "82",
      "elk.edgeRouting": "SPLINES",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    },
    children: semanticNodes.map((node) => ({
      id: node.id,
      ...nodeSize(node),
    })),
    edges: edges
      .filter((edge) => semanticIds.has(edge.source) && semanticIds.has(edge.target))
      .map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] }))
  });
  return Object.fromEntries(
    (graph.children ?? []).map((node) => [
      node.id,
      {
        x: GRAPH_ORIGIN.x + (node.x ?? 0),
        y: GRAPH_ORIGIN.y + (node.y ?? 0),
      }
    ])
  );
}

export function resolveSemanticLayoutCollisions(
  nodes: readonly WorkspaceNode[],
  proposed: Readonly<Record<string, { x: number; y: number }>>,
  pinnedNodeIds: ReadonlySet<string>,
): Record<string, { x: number; y: number }> {
  const occupied: Rect[] = nodes.flatMap((node) => {
    if (
      node.type === "semantic" &&
      !pinnedNodeIds.has(node.id)
    ) {
      return [];
    }
    if (node.hidden) return [];
    return [{ ...node.position, ...nodeSize(node) }];
  });
  const result: Record<string, { x: number; y: number }> = {};
  const movable = nodes
    .filter(
      (node) =>
        node.type === "semantic" &&
        !node.hidden &&
        !pinnedNodeIds.has(node.id) &&
        proposed[node.id],
    )
    .toSorted((left, right) => {
      const leftPosition = proposed[left.id]!;
      const rightPosition = proposed[right.id]!;
      return (
        leftPosition.x - rightPosition.x ||
        leftPosition.y - rightPosition.y ||
        left.id.localeCompare(right.id)
      );
    });

  for (const node of movable) {
    const size = nodeSize(node);
    const initial = proposed[node.id]!;
    const candidate: Rect = { ...initial, ...size };
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const collisions = occupied.filter((rect) =>
        rectanglesOverlap(candidate, rect, COLLISION_GAP),
      );
      if (collisions.length === 0) break;
      candidate.y =
        Math.max(...collisions.map((rect) => rect.y + rect.height)) +
        COLLISION_GAP;
    }
    result[node.id] = { x: candidate.x, y: candidate.y };
    occupied.push(candidate);
  }
  return result;
}

function rectanglesOverlap(left: Rect, right: Rect, gap: number): boolean {
  return !(
    left.x + left.width + gap <= right.x ||
    right.x + right.width + gap <= left.x ||
    left.y + left.height + gap <= right.y ||
    right.y + right.height + gap <= left.y
  );
}
