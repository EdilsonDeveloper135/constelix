import { MarkerType } from "@xyflow/react";
import type { GraphEdge, GraphNode } from "@constelix/contracts";

import type { SemanticNodeKind, WorkspaceEdge, WorkspaceNode } from "../types";

const kindMap: Record<GraphNode["kind"], SemanticNodeKind> = {
  project: "workspace",
  folder: "directory",
  file: "file",
  module: "module",
  class: "class",
  interface: "interface",
  function: "function",
  method: "method",
  external: "external"
};

const columnByKind: Record<GraphNode["kind"], number> = {
  project: 0,
  folder: 0,
  file: 1,
  module: 2,
  class: 3,
  interface: 3,
  function: 4,
  method: 4,
  external: 5
};

export function graphRecordsToFlowNodes(records: GraphNode[]): WorkspaceNode[] {
  const rowByColumn = new Map<number, number>();
  return records.map((record) => {
    const column = columnByKind[record.kind] ?? 0;
    const row = rowByColumn.get(column) ?? 0;
    rowByColumn.set(column, row + 1);
    return {
      id: record.id,
      type: "semantic" as const,
      ariaLabel: `${kindMap[record.kind]}: ${record.name}`,
      position: { x: 130 + column * 190, y: 60 + row * 90 },
      data: {
        kind: kindMap[record.kind],
        label: record.name,
        ...(record.qualifiedName && record.qualifiedName !== record.name
          ? { detail: record.qualifiedName }
          : record.language
            ? { detail: record.language }
            : {}),
        ...(record.relativePath ? { relativePath: record.relativePath } : {}),
        ...(record.language ? { language: record.language } : {}),
        ...(record.range ? { range: record.range } : {}),
      }
    };
  });
}

export function graphRecordsToFlowEdges(records: GraphEdge[]): WorkspaceEdge[] {
  return records.map((record) => ({
    id: record.id,
    source: record.source,
    target: record.target,
    type: "graphEdge",
    markerEnd: { type: MarkerType.ArrowClosed, width: 13, height: 13 },
    data: { relation: record.relation, confidence: record.confidence }
  }));
}
