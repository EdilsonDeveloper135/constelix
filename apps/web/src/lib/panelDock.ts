import type {
  PanelDock,
  WorkspaceNode,
} from "../types";

export function panelDock(node: WorkspaceNode): PanelDock {
  if (node.type === "semantic") return "floating";
  return node.data.dock ?? "floating";
}

export function isFloatingCanvasNode(node: WorkspaceNode): boolean {
  return node.type === "semantic" || panelDock(node) === "floating";
}

export function isDockedToolPanel(
  node: WorkspaceNode,
  dock?: Exclude<PanelDock, "floating">,
): boolean {
  if (node.type === "semantic" || node.hidden) return false;
  const placement = panelDock(node);
  return placement !== "floating" && (dock === undefined || placement === dock);
}

export function panelTool(
  node: Exclude<WorkspaceNode, { type: "semantic" }>,
): "editor" | "terminal" | "ai" {
  if (node.type === "editorPanel") return "editor";
  if (node.type === "terminalPanel") return "terminal";
  return "ai";
}
