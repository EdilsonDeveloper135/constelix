import ELK from "elkjs/lib/elk-api.js";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";

import type { WorkspaceEdge, WorkspaceNode } from "../types";

const elk = new ELK({ workerUrl: elkWorkerUrl });

export async function layoutSemanticNodes(
  nodes: readonly WorkspaceNode[],
  edges: readonly WorkspaceEdge[]
): Promise<Record<string, { x: number; y: number }>> {
  const semanticIds = new Set(nodes.filter((node) => node.type === "semantic").map((node) => node.id));
  const graph = await elk.layout({
    id: "constelix",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "72",
      "elk.spacing.nodeNode": "38",
      "elk.edgeRouting": "SPLINES"
    },
    children: [...semanticIds].map((id) => ({ id, width: 146, height: 48 })),
    edges: edges
      .filter((edge) => semanticIds.has(edge.source) && semanticIds.has(edge.target))
      .map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] }))
  });
  return Object.fromEntries(
    (graph.children ?? []).map((node) => [
      node.id,
      { x: 110 + (node.x ?? 0), y: 48 + (node.y ?? 0) }
    ])
  );
}
