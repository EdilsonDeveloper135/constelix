import type { SemanticNodeData } from "../types";

export interface SemanticNodeCapabilities {
  canInspect: true;
  canActivate: boolean;
  canOpenFile: boolean;
  canOpenTerminal: boolean;
}

export function isSemanticHierarchy(data: SemanticNodeData): boolean {
  return (
    data.kind === "workspace" ||
    data.kind === "directory" ||
    data.kind === "module"
  );
}

export function semanticNodeCapabilities(
  data: SemanticNodeData,
): SemanticNodeCapabilities {
  const hierarchy = isSemanticHierarchy(data);
  return {
    canInspect: true,
    canActivate: hierarchy,
    canOpenFile:
      Boolean(data.relativePath) &&
      data.kind !== "workspace" &&
      data.kind !== "directory",
    canOpenTerminal: hierarchy,
  };
}

export function semanticNodeCwd(data: SemanticNodeData): string {
  const path = data.relativePath ?? ".";
  if (data.kind !== "module") return path;
  const parts = path.split("/");
  parts.pop();
  return parts.join("/") || ".";
}
