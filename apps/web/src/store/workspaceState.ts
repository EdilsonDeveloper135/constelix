import type { PanelState, WorkspaceSummary } from "@constelix/contracts";

import { demoToolPanels } from "../data/demo";
import { persistedPanelDock } from "../lib/layoutPersistence";
import {
  applySemanticViewState,
  hasCapacityHiddenNodes,
} from "../lib/workspaceGraph";
import type {
  BootstrapPayload,
  EvidencePath,
  TerminalFlowNode,
  WorkspaceEdge,
  WorkspaceNode,
} from "../types";

export const EMPTY_WORKSPACE_SUMMARY: WorkspaceSummary = {
  projectTypes: [],
  languages: [],
  estimatedFileCount: 0,
  indexedFileCount: 0,
  warnings: [],
  omittedFiles: [],
  omittedFileCount: 0,
  omittedFilesTruncated: false,
};

export function createConnectedPanelNodes(): WorkspaceNode[] {
  return demoToolPanels.map((node) => {
    const cloned = {
      ...node,
      hidden: true,
      position: { ...node.position },
      data: { ...node.data },
      ...(node.style ? { style: { ...node.style } } : {}),
    } as WorkspaceNode;
    if (cloned.type === "editorPanel") {
      const { contentHash: _contentHash, ...data } = cloned.data;
      return {
        ...cloned,
        data: {
          ...data,
          title: "Código",
          relativePath: "",
          preview: "",
        },
      };
    }
    if (cloned.type === "terminalPanel") {
      return {
        ...cloned,
        data: { ...cloned.data, title: "Terminal — workspace", cwd: "." },
      };
    }
    return cloned;
  });
}

export function sameEvidencePath(
  left: EvidencePath | null,
  right: EvidencePath,
): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

function collapsedSet(
  collapsedNodeIds: Readonly<Record<string, boolean>>,
): Set<string> {
  return new Set(
    Object.entries(collapsedNodeIds)
      .filter(([, collapsed]) => collapsed)
      .map(([id]) => id),
  );
}

function panelResource(saved: PanelState): Record<string, unknown> {
  const { hidden: _hidden, ...resource } = saved.resource;
  return resource;
}

export function withLayout(
  nodes: WorkspaceNode[],
  layout: NonNullable<BootstrapPayload["layout"]>,
): WorkspaceNode[] {
  const lookup = new Map(layout.map((item) => [item.id, item]));
  const restored = nodes.map((node) => {
    const saved = lookup.get(node.id);
    if (!saved) return node;
    const resource = panelResource(saved);
    if (node.type === "semantic") {
      return {
        ...node,
        data: {
          ...node.data,
          ...(resource.collapsed === true ? { collapsed: true } : {}),
        },
        position: saved.pinned ? saved.position : node.position,
      };
    }
    return {
      ...node,
      hidden: saved.resource.hidden === true,
      data: {
        ...node.data,
        ...resource,
        dock: persistedPanelDock(saved),
        ...(saved.anchorNodeId ? { anchorNodeId: saved.anchorNodeId } : {}),
      },
      position: saved.position,
      style: {
        ...node.style,
        width: saved.size.width,
        height: saved.size.height,
      },
    } as WorkspaceNode;
  });
  const activeDockPanelIds = new Set(
    layout.filter((panel) => panel.dockActive).map((panel) => panel.id),
  );
  let nextZIndex = nextToolPanelZIndex(restored);
  return restored.map((node) =>
    node.type !== "semantic" &&
    !node.hidden &&
    activeDockPanelIds.has(node.id)
      ? { ...node, zIndex: nextZIndex++ }
      : node,
  ) as WorkspaceNode[];
}

export function restoreAdditionalTerminals(
  nodes: WorkspaceNode[],
  layout: NonNullable<BootstrapPayload["layout"]>,
): WorkspaceNode[] {
  const existingIds = new Set(nodes.map((node) => node.id));
  let nextZIndex = nextToolPanelZIndex(nodes);
  const additional = layout.flatMap<TerminalFlowNode>((saved) => {
    if (saved.kind !== "terminal" || existingIds.has(saved.id)) return [];
    const title =
      typeof saved.resource.title === "string"
        ? saved.resource.title
        : "Terminal — .";
    const cwd =
      typeof saved.resource.cwd === "string" ? saved.resource.cwd : ".";
    const collapsed = saved.resource.collapsed === true;
    const expandedHeight =
      typeof saved.resource.expandedHeight === "number"
        ? saved.resource.expandedHeight
        : saved.size.height;
    return [
      {
        id: saved.id,
        type: "terminalPanel",
        position: saved.position,
        style: { width: saved.size.width, height: saved.size.height },
        dragHandle: ".panel-titlebar",
        hidden: saved.resource.hidden === true,
        data: {
          panelType: "terminal",
          dock: persistedPanelDock(saved),
          title,
          cwd,
          collapsed,
          expandedHeight,
          ...(saved.anchorNodeId ? { anchorNodeId: saved.anchorNodeId } : {}),
        },
        zIndex: nextZIndex++,
      },
    ];
  });
  return [...nodes, ...additional];
}

export function nextToolPanelZIndex(
  nodes: readonly WorkspaceNode[],
): number {
  return (
    Math.max(
      20,
      ...nodes
        .filter((node) => node.type !== "semantic")
        .map((node) => node.zIndex ?? 0),
    ) + 1
  );
}

export function deriveCollapsedNodes(
  layout: BootstrapPayload["layout"],
): Record<string, boolean> {
  return Object.fromEntries(
    (layout ?? [])
      .filter(
        (item) => item.kind === "index" && item.resource.collapsed === true,
      )
      .map((item) => [item.id, true]),
  );
}

export function visibleGraphState(
  nodes: WorkspaceNode[],
  edges: WorkspaceEdge[],
  collapsedNodeIds: Readonly<Record<string, boolean>>,
  expansionCursors: Readonly<Record<string, string | null>>,
  sourceTruncated: boolean,
  forcedVisibleNodeIds: Readonly<Record<string, boolean>> = {},
): { nodes: WorkspaceNode[]; graphTruncated: boolean } {
  const visibleNodes = applySemanticViewState(
    nodes,
    edges,
    collapsedSet(collapsedNodeIds),
    expansionCursors,
    collapsedSet(forcedVisibleNodeIds),
  );
  return {
    nodes: visibleNodes,
    graphTruncated: sourceTruncated || hasCapacityHiddenNodes(visibleNodes),
  };
}
