import type {
  CanvasFilters,
  SemanticFlowNode,
  SemanticNodeKind,
  WorkspaceEdge,
  WorkspaceNode,
} from "../types";

export interface FilteredGraph {
  nodes: WorkspaceNode[];
  edges: WorkspaceEdge[];
  evidenceOverrides: number;
}

export function nodeExtension(node: SemanticFlowNode): string | undefined {
  const path = node.data.relativePath;
  if (!path) return undefined;
  const name = path.split("/").at(-1) ?? path;
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === name.length - 1) return undefined;
  return name.slice(dotIndex).toLocaleLowerCase();
}

export function availableExtensions(nodes: readonly WorkspaceNode[]): string[] {
  return [
    ...new Set(
      nodes.flatMap((node) =>
        node.type === "semantic" ? nodeExtension(node) ?? [] : [],
      ),
    ),
  ].sort();
}

export function applyCanvasFilters(
  nodes: readonly WorkspaceNode[],
  edges: readonly WorkspaceEdge[],
  filters: CanvasFilters,
  evidenceNodeIds: ReadonlySet<string> = new Set(),
): FilteredGraph {
  let evidenceOverrides = 0;
  const visibleIds = new Set<string>();
  const filteredNodes = nodes.map((node) => {
    if (node.type !== "semantic") return node;
    const kindMatches =
      filters.nodeKind === "all" || node.data.kind === filters.nodeKind;
    const extensionMatches =
      filters.extension === "all" ||
      nodeExtension(node) === filters.extension;
    const filterHidden = !kindMatches || !extensionMatches;
    const forcedByEvidence = evidenceNodeIds.has(node.id);
    if (filterHidden && forcedByEvidence && !node.hidden) {
      evidenceOverrides += 1;
    }
    const hidden = Boolean(node.hidden) || (filterHidden && !forcedByEvidence);
    if (!hidden) visibleIds.add(node.id);
    if (hidden === Boolean(node.hidden)) return node;
    return { ...node, hidden };
  }) as WorkspaceNode[];

  const filteredEdges = edges.filter(
    (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
  );
  return { nodes: filteredNodes, edges: filteredEdges, evidenceOverrides };
}

export const FILTERABLE_NODE_KINDS: readonly SemanticNodeKind[] = [
  "workspace",
  "directory",
  "file",
  "module",
  "class",
  "interface",
  "function",
  "method",
  "route",
  "service",
  "external",
];
