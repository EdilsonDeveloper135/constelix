import type { GraphNodeKind, GraphRelation } from "@constelix/contracts";

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

export function analyzerStableId(namespace: string, ...parts: readonly string[]): string {
  const canonical = parts.map((part) => {
    const value = part.normalize("NFC").replaceAll("\\", "/");
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
