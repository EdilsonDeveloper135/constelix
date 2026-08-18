import { stableId, type GraphNodeKind, type GraphRelation } from "@constelix/contracts";

/**
 * @deprecated Use `stableId` from `@constelix/contracts` directly. Kept as
 * an alias so existing analyzer call sites do not need to change.
 */
export const analyzerStableId = stableId;

export function analysisNodeId(
  workspaceId: string,
  kind: GraphNodeKind,
  relativePath: string,
  qualifiedName = ""
): string {
  return analyzerStableId(kind, workspaceId, relativePath, qualifiedName);
}

export function analysisEdgeId(source: string, relation: GraphRelation, target: string): string {
  return analyzerStableId("edge", source, relation, target, "");
}
