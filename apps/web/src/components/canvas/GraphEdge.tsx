import { memo } from "react";
import { BaseEdge, getSmoothStepPath, type EdgeProps } from "@xyflow/react";

import type { GraphRelation, WorkspaceEdge } from "../../types";

const relationColors: Record<GraphRelation, string> = {
  contains: "#858f92",
  imports: "#90989b",
  exports: "#43c7e2",
  extends: "#a681d2",
  implements: "#a681d2",
  calls: "#75c967"
};

export const GraphEdge = memo(function GraphEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data
}: EdgeProps<WorkspaceEdge>) {
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 13,
    offset: 22
  });
  const relation = data?.relation ?? "contains";
  const confidence = data?.confidence ?? "extracted";
  const active = data?.evidenceActive;
  const visited = data?.evidenceVisited;
  const color = active || visited ? "#53d5ed" : relationColors[relation];

  return (
    <BaseEdge
      id={id}
      path={path}
      {...(markerEnd ? { markerEnd } : {})}
      className={`graph-edge graph-edge--${relation}${confidence !== "extracted" ? " graph-edge--inferred" : ""}${active ? " graph-edge--active" : ""}${visited ? " graph-edge--visited" : ""}`}
      style={{ stroke: color, strokeWidth: active ? 2.2 : visited ? 1.8 : 1.15 }}
    />
  );
});
