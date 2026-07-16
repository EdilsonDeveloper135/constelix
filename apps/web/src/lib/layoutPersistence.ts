import type { PanelKind, PanelState } from "@constelix/contracts";

import type { AssistantMode, WorkspaceNode } from "../types";

interface WorkspaceLayoutInput {
  nodes: readonly WorkspaceNode[];
  assistantMode: AssistantMode;
  collapsedNodeIds: Readonly<Record<string, boolean>>;
  pinnedSemanticNodeIds: Readonly<Record<string, boolean>>;
  updatedAt?: string;
}

let lastLayoutTimestamp = 0;

function nextLayoutUpdatedAt(): string {
  const timestamp = Math.max(Date.now(), lastLayoutTimestamp + 1);
  lastLayoutTimestamp = timestamp;
  return new Date(timestamp).toISOString();
}

export function derivePinnedSemanticNodes(
  layout: readonly PanelState[] | undefined,
): Record<string, boolean> {
  return Object.fromEntries(
    (layout ?? [])
      .filter((item) => item.kind === "index" && item.pinned)
      .map((item) => [item.id, true]),
  );
}

export function serializeWorkspaceLayout({
  nodes,
  assistantMode,
  collapsedNodeIds,
  pinnedSemanticNodeIds,
  updatedAt = nextLayoutUpdatedAt(),
}: WorkspaceLayoutInput): PanelState[] {
  return nodes.flatMap<PanelState>((node) => {
    const semanticPinned =
      node.type === "semantic" && Boolean(pinnedSemanticNodeIds[node.id]);
    const semanticCollapsed =
      node.type === "semantic" && Boolean(collapsedNodeIds[node.id]);
    if (node.type === "semantic" && !semanticPinned && !semanticCollapsed) {
      return [];
    }

    const width =
      node.measured?.width ??
      (typeof node.style?.width === "number"
        ? node.style.width
        : node.type === "semantic"
          ? 126
          : 480);
    const height =
      node.measured?.height ??
      (typeof node.style?.height === "number"
        ? node.style.height
        : node.type === "semantic"
          ? 43
          : 240);
    const kind: PanelKind =
      node.type === "semantic"
        ? "index"
        : node.type === "editorPanel"
          ? "editor"
          : node.type === "terminalPanel"
            ? "terminal"
            : assistantMode;
    const anchorNodeId =
      "anchorNodeId" in node.data &&
      typeof node.data.anchorNodeId === "string"
        ? node.data.anchorNodeId
        : undefined;
    const resource =
      node.type === "semantic"
        ? {
            semantic: true,
            collapsed: semanticCollapsed,
          }
        : node.type === "editorPanel"
          ? {
              title: node.data.title,
              relativePath: node.data.relativePath,
              language: node.data.language,
              hidden: Boolean(node.hidden),
              collapsed: Boolean(node.data.collapsed),
              expandedHeight: node.data.expandedHeight ?? height,
            }
          : node.type === "terminalPanel"
            ? {
                title: node.data.title,
                cwd: node.data.cwd,
                hidden: Boolean(node.hidden),
                collapsed: Boolean(node.data.collapsed),
                expandedHeight: node.data.expandedHeight ?? height,
              }
            : {
                title: node.data.title,
                mode: assistantMode,
                hidden: Boolean(node.hidden),
                collapsed: Boolean(node.data.collapsed),
                expandedHeight: node.data.expandedHeight ?? height,
              };

    return [{
      protocolVersion: 1,
      id: node.id,
      kind,
      position: node.position,
      size: { width, height },
      resource,
      ...(anchorNodeId ? { anchorNodeId } : {}),
      zoom: 1,
      pinned: semanticPinned,
      updatedAt,
    }];
  });
}
