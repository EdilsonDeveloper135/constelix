import { applyEdgeChanges, applyNodeChanges, type EdgeChange, type NodeChange } from "@xyflow/react";
import { create } from "zustand";
import type {
  ActTask as ContractActTask,
  ActTaskStatus,
  PanelState,
  WorkspaceSummary,
} from "@constelix/contracts";

import {
  demoEdges,
  demoEvidencePath,
  demoIndexStatus,
  demoNodes,
  demoToolPanels,
} from "../data/demo";
import { AgentRequestError, apiClient } from "../lib/api";
import { closeMonacoLspConnections } from "../lib/lsp";
import { graphRecordsToFlowEdges, graphRecordsToFlowNodes } from "../lib/graph";
import {
  layoutSemanticNodes,
  resolveSemanticLayoutCollisions,
} from "../lib/layout";
import {
  derivePinnedSemanticNodes,
  persistedPanelDock,
  serializeWorkspaceLayout,
} from "../lib/layoutPersistence";
import { isFloatingCanvasNode } from "../lib/panelDock";
import { markTerminalRuntimeExited } from "../lib/terminalRuntime";
import { isAbortError, retryWithDelays } from "../lib/retry";
import {
  applySemanticViewState,
  hasCapacityHiddenNodes,
  mergeGraphSnapshotPage,
  mergeRevisionedGraphDelta,
} from "../lib/workspaceGraph";
import { canUseWorkspaceFeatures } from "../lib/workspaceAccess";
import type {
  ActTask,
  AgentEvent,
  AssistantMode,
  BootstrapPayload,
  CanvasFilters,
  ConnectionState,
  ConversationMessage,
  EditorPanelData,
  EvidencePath,
  IndexStatus,
  PanelDock,
  RailTool,
  TerminalFlowNode,
  TerminalPanelData,
  TerminalRuntime,
  WorkspaceAskMode,
  WorkspaceAskProviderStatus,
  WorkspaceEdge,
  WorkspaceMode,
  WorkspaceNode,
  WorkspaceNotice,
} from "../types";

interface WorkspaceState {
  workspaceId: string;
  workspaceName: string;
  askThreadId: string;
  rootPath: string;
  branch: string;
  workspaceMode: WorkspaceMode;
  workspaceSummary: WorkspaceSummary;
  onboardingOpen: boolean;
  notices: WorkspaceNotice[];
  connection: ConnectionState;
  demoMode: boolean;
  activeTool: RailTool;
  commandPaletteOpen: boolean;
  settingsOpen: boolean;
  nodes: WorkspaceNode[];
  edges: WorkspaceEdge[];
  graphRevision: number;
  graphSourceTruncated: boolean;
  graphTruncated: boolean;
  graphCursor: string | undefined;
  graphReconciling: boolean;
  remoteHydrated: boolean;
  selectedNodeId: string | null;
  expansionCursors: Record<string, string | null>;
  collapsedNodeIds: Record<string, boolean>;
  pinnedSemanticNodeIds: Record<string, boolean>;
  semanticVersion: number;
  compactMode: boolean;
  canvasFilters: CanvasFilters;
  terminalRuntimes: Record<string, TerminalRuntime>;
  index: IndexStatus;
  assistantMode: AssistantMode;
  question: string;
  answer: string;
  conversation: ConversationMessage[];
  assistantError: string | null;
  assistantThinking: boolean;
  activeAskTurnId: string | null;
  activeAskRequestId: string | null;
  evidencePath: EvidencePath | null;
  evidenceCursor: number;
  evidencePartial: boolean;
  evidenceForcedNodeIds: Record<string, boolean>;
  actTask: ActTask | null;
  askAvailable: boolean;
  askMode: WorkspaceAskMode;
  askProviderStatus: WorkspaceAskProviderStatus;
  askNotice: string | undefined;
  actAvailable: boolean;
  codexReason: string | undefined;
  codexChecking: boolean;
  codexVersion: string | undefined;
  onNodesChange: (changes: NodeChange<WorkspaceNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<WorkspaceEdge>[]) => void;
  setConnection: (connection: ConnectionState) => void;
  hydrateBootstrap: (
    payload: BootstrapPayload,
    guards?: HydrationGuards,
  ) => void;
  reconcileGraph: () => Promise<void>;
  handleAgentEvent: (event: AgentEvent) => void;
  selectNode: (id: string | null) => void;
  raisePanel: (id: string) => void;
  openFile: (relativePath: string, anchorNodeId?: string) => void;
  openTerminal: (cwd?: string, anchorNodeId?: string) => void;
  createTerminal: (cwd?: string, anchorNodeId?: string, dock?: PanelDock) => void;
  registerTerminalRuntime: (panelId: string, runtime: TerminalRuntime) => void;
  clearTerminalRuntime: (panelId: string) => void;
  expandNode: (nodeId: string) => Promise<void>;
  loadNextGraphPage: () => Promise<void>;
  activateSemanticNode: (nodeId: string) => Promise<void>;
  toggleSemanticCollapse: (nodeId: string) => void;
  setCanvasZoom: (zoom: number) => void;
  setNodeKindFilter: (kind: CanvasFilters["nodeKind"]) => void;
  setExtensionFilter: (extension: string) => void;
  resetCanvasFilters: () => void;
  acknowledgeOnboarding: () => void;
  dismissNotice: (id: string) => void;
  setActiveTool: (tool: RailTool) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  togglePanel: (id: string, visible?: boolean) => void;
  setPanelDock: (id: string, dock: PanelDock) => void;
  closePanel: (id: string) => void;
  setPanelCollapsed: (id: string, collapsed: boolean, expandedHeight: number) => void;
  updateEditorPanel: (patch: Partial<EditorPanelData>) => void;
  updateTerminalPanel: (patch: Partial<TerminalPanelData>) => void;
  setAssistantMode: (mode: AssistantMode) => void;
  setQuestion: (question: string) => void;
  submitQuestion: () => Promise<void>;
  cancelQuestion: () => void;
  playEvidencePath: (path: EvidencePath) => void;
  navigateEvidence: (nodeId: string) => Promise<void>;
  createActTask: () => Promise<void>;
  approveActTask: () => Promise<void>;
  cancelActTask: () => Promise<void>;
  resetActTask: () => void;
  saveLayout: () => void;
  flushLayout: () => void;
  saveLayoutNow: () => Promise<void>;
}

interface HydrationGuards {
  preserveGraph?: boolean;
  preserveAsk?: boolean;
  preserveAct?: boolean;
  preserveIndex?: boolean;
  preserveTerminals?: boolean;
  preserveConnection?: boolean;
  preserveActCapability?: boolean;
  preserveAskCapability?: boolean;
}

let evidenceTimer: number | null = null;
let layoutTimer: number | null = null;
let reconcilePromise: Promise<void> | null = null;
let reconcileAgain = false;
let graphTransportEpoch = 0;
let askTransportEpoch = 0;
let actTransportEpoch = 0;
let indexTransportEpoch = 0;
let terminalTransportEpoch = 0;
let connectionTransportEpoch = 0;
let actCapabilityTransportEpoch = 0;
let askCapabilityTransportEpoch = 0;
let layoutRequestEpoch = 0;
let reconcileAbortController: AbortController | null = null;
const BOOTSTRAP_RETRY_DELAYS_MS = [0, 150, 600] as const;
const startsInDemoMode = !apiClient.hasToken;
const emptyWorkspaceSummary: WorkspaceSummary = {
  projectTypes: [],
  languages: [],
  estimatedFileCount: 0,
  indexedFileCount: 0,
  warnings: [],
  omittedFiles: [],
  omittedFileCount: 0,
  omittedFilesTruncated: false,
};

function createConnectedPanelNodes(): WorkspaceNode[] {
  return demoToolPanels.map((node) => {
    const cloned = {
      ...node,
      position: { ...node.position },
      data: { ...node.data },
      ...(node.style ? { style: { ...node.style } } : {}),
    } as WorkspaceNode;
    if (cloned.type === "editorPanel") {
      const { contentHash: _contentHash, ...data } = cloned.data;
      return {
        ...cloned,
        hidden: true,
        data: {
          ...data,
          title: "Editor",
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

function collapsedSet(collapsedNodeIds: Readonly<Record<string, boolean>>): Set<string> {
  return new Set(
    Object.entries(collapsedNodeIds)
      .filter(([, collapsed]) => collapsed)
      .map(([id]) => id),
  );
}

function sameEvidencePath(
  left: EvidencePath | null,
  right: EvidencePath,
): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

function panelResource(saved: PanelState): Record<string, unknown> {
  const { hidden: _hidden, ...resource } = saved.resource;
  return resource;
}

function withLayout(nodes: WorkspaceNode[], layout: NonNullable<BootstrapPayload["layout"]>): WorkspaceNode[] {
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

function restoreAdditionalTerminals(
  nodes: WorkspaceNode[],
  layout: NonNullable<BootstrapPayload["layout"]>,
): WorkspaceNode[] {
  const existingIds = new Set(nodes.map((node) => node.id));
  let nextZIndex = nextToolPanelZIndex(nodes);
  const additional = layout.flatMap<TerminalFlowNode>((saved) => {
    if (saved.kind !== "terminal" || existingIds.has(saved.id)) return [];
    const title = typeof saved.resource.title === "string" ? saved.resource.title : "Terminal — .";
    const cwd = typeof saved.resource.cwd === "string" ? saved.resource.cwd : ".";
    const collapsed = saved.resource.collapsed === true;
    const expandedHeight =
      typeof saved.resource.expandedHeight === "number"
        ? saved.resource.expandedHeight
        : saved.size.height;
    return [{
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
    }];
  });
  return [...nodes, ...additional];
}

function nextToolPanelZIndex(nodes: readonly WorkspaceNode[]): number {
  return (
    Math.max(
      20,
      ...nodes
        .filter((node) => node.type !== "semantic")
        .map((node) => node.zIndex ?? 0),
    ) + 1
  );
}

function deriveCollapsedNodes(
  layout: BootstrapPayload["layout"],
): Record<string, boolean> {
  return Object.fromEntries(
    (layout ?? [])
      .filter((item) => item.kind === "index" && item.resource.collapsed === true)
      .map((item) => [item.id, true]),
  );
}

function visibleGraphState(
  nodes: WorkspaceNode[],
  edges: WorkspaceEdge[],
  collapsedNodeIds: Readonly<Record<string, boolean>>,
  expansionCursors: Readonly<Record<string, string | null>>,
  sourceTruncated: boolean,
  forcedVisibleNodeIds: Readonly<Record<string, boolean>> = {},
): Pick<WorkspaceState, "nodes" | "graphTruncated"> {
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

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaceId: startsInDemoMode ? "demo" : "",
  workspaceName: startsInDemoMode ? "constelix" : "Conectando…",
  askThreadId: startsInDemoMode ? "workspace-main" : "",
  rootPath: startsInDemoMode ? "~/Proyectos/constelix" : "Cargando workspace…",
  branch: startsInDemoMode ? "main" : "—",
  workspaceMode: "edit",
  workspaceSummary: startsInDemoMode
    ? {
        ...emptyWorkspaceSummary,
        projectTypes: ["Monorepo pnpm"],
        languages: ["typescript", "javascript"],
        estimatedFileCount: demoIndexStatus.filesIndexed,
        indexedFileCount: demoIndexStatus.filesIndexed,
      }
    : emptyWorkspaceSummary,
  onboardingOpen: true,
  notices: [],
  connection: "connecting",
  demoMode: startsInDemoMode,
  activeTool: "map",
  commandPaletteOpen: false,
  settingsOpen: false,
  nodes: startsInDemoMode ? demoNodes : createConnectedPanelNodes(),
  edges: startsInDemoMode ? demoEdges : [],
  graphRevision: 0,
  graphSourceTruncated: false,
  graphTruncated: false,
  graphCursor: undefined,
  graphReconciling: false,
  remoteHydrated: false,
  selectedNodeId: startsInDemoMode ? "fn-indexer" : null,
  expansionCursors: {},
  collapsedNodeIds: {},
  pinnedSemanticNodeIds: {},
  semanticVersion: startsInDemoMode ? 1 : 0,
  compactMode: false,
  canvasFilters: { nodeKind: "all", extension: "all" },
  terminalRuntimes: {},
  index: startsInDemoMode
    ? demoIndexStatus
    : {
        phase: "scanning",
        progress: 0,
        filesIndexed: 0,
        symbolsIndexed: 0,
        edgesIndexed: 0,
        message: "Conectando con el agente local…",
      },
  assistantMode: "ask",
  question: startsInDemoMode ? "¿Cómo llega una consulta al grafo?" : "",
  answer: startsInDemoMode
    ? "La consulta entra por `/api/query`, pasa por `query.handler.ts` y `QueryService`. Después, `GraphIndexer` consulta `ProjectGraph`."
    : "",
  conversation: startsInDemoMode
    ? [
        { role: "user", content: "¿Cómo llega una consulta al grafo?" },
        {
          role: "assistant",
          content:
            "La consulta entra por `/api/query`, pasa por `query.handler.ts` y `QueryService`. Después, `GraphIndexer` consulta `ProjectGraph`.",
          evidence: demoEvidencePath,
        },
      ]
    : [],
  assistantError: null,
  assistantThinking: false,
  activeAskTurnId: null,
  activeAskRequestId: null,
  evidencePath: startsInDemoMode ? demoEvidencePath : null,
  evidenceCursor: startsInDemoMode ? demoEvidencePath.nodeIds.length : 0,
  evidencePartial: false,
  evidenceForcedNodeIds: {},
  actTask: null,
  askAvailable: startsInDemoMode,
  askMode: startsInDemoMode ? "openai" : "local",
  askProviderStatus: startsInDemoMode ? "ready" : "unavailable",
  askNotice: undefined,
  actAvailable: startsInDemoMode,
  codexReason: startsInDemoMode
    ? undefined
    : "Comprobando el agente local…",
  codexChecking: !startsInDemoMode,
  codexVersion: undefined,

  onNodesChange: (changes) =>
    set((state) => {
      const semanticIds = new Set(
        state.nodes
          .filter((node) => node.type === "semantic")
          .map((node) => node.id),
      );
      const pinnedSemanticNodeIds = {
        ...state.pinnedSemanticNodeIds,
      };
      for (const change of changes) {
        if (change.type === "position" && semanticIds.has(change.id)) {
          pinnedSemanticNodeIds[change.id] = true;
        } else if (change.type === "remove") {
          delete pinnedSemanticNodeIds[change.id];
        }
      }
      return {
        nodes: applyNodeChanges(changes, state.nodes) as WorkspaceNode[],
        pinnedSemanticNodeIds,
      };
    }),
  onEdgesChange: (changes) =>
    set((state) => ({
      edges: applyEdgeChanges(changes, state.edges) as WorkspaceEdge[],
    })),
  setConnection: (connection) => {
    connectionTransportEpoch += 1;
    if (connection === "degraded") {
      reconcileAbortController?.abort();
    }
    set({ connection });
  },

  hydrateBootstrap: (payload, guards = {}) => {
    const previous = get();
    const sameWorkspace =
      previous.remoteHydrated && previous.workspaceId === payload.workspace.id;
    const preserveSessionState = sameWorkspace;
    const preserveGraphState =
      sameWorkspace &&
      (Boolean(guards.preserveGraph) ||
        (preserveSessionState &&
          previous.graphRevision >= payload.graph.revision));
    const preserveActiveAsk =
      preserveSessionState &&
      previous.assistantThinking &&
      ((previous.activeAskTurnId !== null &&
        payload.activeAskTurnIds.includes(previous.activeAskTurnId)) ||
        (previous.activeAskTurnId === null &&
          previous.activeAskRequestId !== null));
    const preserveAskState =
      Boolean(guards.preserveAsk) || preserveActiveAsk;
    const preserveActState = Boolean(guards.preserveAct);
    const previousPositions = new Map(
      previous.nodes
        .filter((node) => node.type === "semantic")
        .map((node) => [node.id, node.position]),
    );
    const semanticNodes = preserveGraphState
      ? previous.nodes.filter(
          (
            node,
          ): node is Extract<WorkspaceNode, { type: "semantic" }> =>
            node.type === "semantic",
        )
      : graphRecordsToFlowNodes(payload.graph.nodes).map((node) => ({
          ...node,
          position:
            preserveSessionState
              ? previousPositions.get(node.id) ?? node.position
              : node.position,
        }));
    const graphEdges = preserveGraphState
      ? previous.edges
      : graphRecordsToFlowEdges(payload.graph.edges);
    const firstFile = semanticNodes.find(
      (node): node is Extract<WorkspaceNode, { type: "semantic" }> =>
        node.type === "semantic" &&
        node.data.kind === "file" &&
        Boolean(node.data.relativePath),
    );
    const panelNodes = (sameWorkspace
      ? previous.nodes.filter((node) => node.type !== "semantic")
      : createConnectedPanelNodes())
      .filter((node) => node.type !== "semantic")
      .map((node) => {
        if (preserveSessionState) return node;
        if (node.type === "editorPanel" && firstFile?.data.relativePath) {
          const relativePath = firstFile.data.relativePath;
          return {
            ...node,
            data: {
              ...node.data,
              title: `Editor — ${relativePath.split("/").at(-1) ?? relativePath}`,
              relativePath,
              language:
                firstFile.data.language ??
                (relativePath.endsWith(".py") ? "python" : "typescript"),
            },
          };
        }
        if (node.type === "editorPanel" && !firstFile) {
          return { ...node, hidden: true };
        }
        if (node.type === "terminalPanel" && node.id === "panel-terminal") {
          return {
            ...node,
            data: {
              ...node.data,
              title: `Terminal — ${payload.workspace.name}`,
              cwd: ".",
            },
          };
        }
        return node;
      });
    const mergedNodes = [...semanticNodes, ...panelNodes] as WorkspaceNode[];
    const restoredNodes = payload.layout && !preserveSessionState
      ? withLayout(
          restoreAdditionalTerminals(mergedNodes, payload.layout),
          payload.layout,
        )
      : mergedNodes;
    const collapsedNodeIds = preserveSessionState
      ? previous.collapsedNodeIds
      : deriveCollapsedNodes(payload.layout);
    const pinnedSemanticNodeIds = preserveSessionState
      ? previous.pinnedSemanticNodeIds
      : derivePinnedSemanticNodes(payload.layout);
    const expansionCursors: Record<string, string | null> = preserveGraphState
      ? previous.expansionCursors
      : {};
    const graphSourceTruncated = preserveGraphState
      ? previous.graphSourceTruncated
      : payload.graph.truncated;
    const evidenceForcedNodeIds = preserveAskState
      ? previous.evidenceForcedNodeIds
      : {};
    const visibleState = visibleGraphState(
      restoredNodes,
      graphEdges,
      collapsedNodeIds,
      expansionCursors,
      graphSourceTruncated,
      evidenceForcedNodeIds,
    );
    const restoredAssistant = visibleState.nodes.find(
      (node) => node.type === "assistantPanel",
    );
    const lastAssistant = payload.conversation?.findLast(
      (message) => message.role === "assistant",
    );
    const terminalPanelCwds = new Map(
      visibleState.nodes
        .filter((node) => node.type === "terminalPanel")
        .map((node) => [node.id, node.data.cwd] as const),
    );
    const terminalPanelIds = new Set(terminalPanelCwds.keys());
    const restoredTerminalRuntimes =
      guards.preserveTerminals && sameWorkspace
        ? previous.terminalRuntimes
        : Object.fromEntries(
            payload.terminals.flatMap((terminal) =>
              terminal.panelId && terminalPanelIds.has(terminal.panelId)
                ? [[terminal.panelId, {
                    terminalId: terminal.id,
                    cwd: terminalPanelCwds.get(terminal.panelId) ?? ".",
                    status: terminal.status,
                  } satisfies TerminalRuntime]]
                : [],
            ),
          );
    const restoredActTask = payload.activeActTask
      ? toViewActTask(payload.activeActTask)
      : null;
    const reconciledActTask = reconcileActTask(
      previous.actTask,
      restoredActTask,
      preserveActState,
      preserveSessionState,
    );
    const applyHydration = () => set({
      workspaceId: payload.workspace.id,
      workspaceName: payload.workspace.name,
      askThreadId: `${payload.workspace.id}:main`,
      rootPath: payload.workspace.rootPath,
      branch: payload.workspace.branch ?? "—",
      workspaceMode: payload.workspace.mode,
      workspaceSummary: payload.summary,
      onboardingOpen: sameWorkspace ? previous.onboardingOpen : true,
      notices: sameWorkspace ? previous.notices : [],
      nodes: visibleState.nodes,
      edges: graphEdges,
      graphRevision: preserveGraphState
        ? previous.graphRevision
        : payload.graph.revision,
      graphSourceTruncated,
      graphTruncated: visibleState.graphTruncated,
      graphCursor: preserveGraphState
        ? previous.graphCursor
        : payload.graph.cursor,
      graphReconciling: false,
      remoteHydrated: true,
      expansionCursors,
      collapsedNodeIds,
      pinnedSemanticNodeIds,
      semanticVersion:
        preserveGraphState && sameWorkspace
          ? previous.semanticVersion
          : previous.semanticVersion + 1,
      terminalRuntimes: restoredTerminalRuntimes,
      index:
        guards.preserveIndex
          ? previous.index
          : payload.index,
      connection: guards.preserveConnection
        ? previous.connection
        : "connected",
      demoMode: false,
      question: preserveSessionState ? previous.question : "",
      answer: preserveAskState ? previous.answer : "",
      conversation:
        preserveAskState
          ? previous.conversation
          : payload.conversation ?? [],
      assistantError: preserveAskState ? previous.assistantError : null,
      assistantThinking: preserveAskState
        ? previous.assistantThinking
        : false,
      activeAskTurnId: preserveAskState
        ? previous.activeAskTurnId
        : null,
      activeAskRequestId: preserveAskState
        ? previous.activeAskRequestId
        : null,
      evidencePath: preserveAskState
        ? previous.evidencePath
        : lastAssistant?.evidence ?? null,
      evidenceCursor: preserveAskState
        ? previous.evidenceCursor
        : lastAssistant?.evidence?.nodeIds.length ?? 0,
      evidencePartial: preserveAskState
        ? previous.evidencePartial
        : false,
      evidenceForcedNodeIds,
      actTask: reconciledActTask,
      assistantMode:
        restoredAssistant?.type === "assistantPanel"
          ? restoredAssistant.data.mode
          : "ask",
      askAvailable: guards.preserveAskCapability
        ? previous.askAvailable
        : payload.capabilities?.ask ?? false,
      askMode: guards.preserveAskCapability
        ? previous.askMode
        : payload.capabilities?.askMode ?? "local",
      askProviderStatus: guards.preserveAskCapability
        ? previous.askProviderStatus
        : payload.capabilities?.askProviderStatus ?? "unavailable",
      askNotice: guards.preserveAskCapability
        ? previous.askNotice
        : payload.capabilities?.askNotice,
      actAvailable: guards.preserveActCapability
        ? previous.actAvailable
        : payload.workspace.mode === "edit" &&
          (payload.capabilities?.act ?? false),
      codexReason: guards.preserveActCapability
        ? previous.codexReason
        : payload.workspace.mode === "read"
          ? "Actuar está deshabilitado en Modo Lectura."
          : payload.capabilities?.codexReason,
      codexChecking: guards.preserveActCapability
        ? previous.codexChecking
        : payload.capabilities?.codexChecking ?? false,
      codexVersion: guards.preserveActCapability
        ? previous.codexVersion
        : payload.capabilities?.codexVersion,
      canvasFilters: sameWorkspace
        ? previous.canvasFilters
        : { nodeKind: "all", extension: "all" },
    });
    if (apiClient.hasToken) {
      apiClient.commitHydratedWorkspace(payload.session.id, applyHydration);
    } else {
      applyHydration();
    }
    if (!guards.preserveTerminals) {
      for (const terminal of payload.terminals) {
        if (terminal.panelId && !terminalPanelIds.has(terminal.panelId)) {
          void apiClient.deleteTerminal(terminal.id).catch(() => undefined);
        }
      }
    }
    if (!preserveGraphState) {
      void applySemanticLayout();
    }
  },

  reconcileGraph: async () => {
    if (get().demoMode || !apiClient.hasToken) return;
    reconcileAgain = true;
    if (reconcilePromise) {
      return reconcilePromise;
    }

    reconcilePromise = (async () => {
      set({ graphReconciling: true });
      try {
        while (reconcileAgain) {
          reconcileAgain = false;
          const epochs = {
            graph: graphTransportEpoch,
            ask: askTransportEpoch,
            act: actTransportEpoch,
            index: indexTransportEpoch,
            terminal: terminalTransportEpoch,
            connection: connectionTransportEpoch,
            actCapability: actCapabilityTransportEpoch,
            askCapability: askCapabilityTransportEpoch,
          };
          const controller = new AbortController();
          reconcileAbortController = controller;
          try {
            const payload = await retryWithDelays(
              (signal) => apiClient.bootstrap(signal),
              {
                signal: controller.signal,
                retryDelaysMs: BOOTSTRAP_RETRY_DELAYS_MS,
                shouldRetry: (error) =>
                  get().connection !== "degraded" &&
                  isTransientBootstrapError(error),
              },
            );
            get().hydrateBootstrap(payload, {
              preserveGraph: graphTransportEpoch !== epochs.graph,
              preserveAsk: askTransportEpoch !== epochs.ask,
              preserveAct: actTransportEpoch !== epochs.act,
              preserveIndex: indexTransportEpoch !== epochs.index,
              preserveTerminals:
                terminalTransportEpoch !== epochs.terminal,
              preserveConnection:
                connectionTransportEpoch !== epochs.connection,
              preserveActCapability:
                actCapabilityTransportEpoch !== epochs.actCapability,
              preserveAskCapability:
                askCapabilityTransportEpoch !== epochs.askCapability,
            });
          } catch (error: unknown) {
            if (!isAbortError(error)) {
              set((state) => ({
                ...(connectionTransportEpoch === epochs.connection
                  ? { connection: "degraded" as const }
                  : { connection: state.connection }),
                assistantError:
                  error instanceof Error
                    ? error.message
                    : "No se pudo reconciliar el grafo.",
              }));
            }
          } finally {
            if (reconcileAbortController === controller) {
              reconcileAbortController = null;
            }
          }
        }
      } finally {
        reconcilePromise = null;
        set({ graphReconciling: false });
      }
    })();
    return reconcilePromise;
  },

  handleAgentEvent: (event) => {
    switch (event.type) {
      case "connection.ready":
        get().setConnection(
          get().remoteHydrated ? "connected" : "connecting",
        );
        set({ demoMode: false });
        void get().reconcileGraph();
        break;
      case "workspace.changed":
        closeMonacoLspConnections();
        reconcileAbortController?.abort();
        connectionTransportEpoch += 1;
        set({
          connection: "connecting",
          remoteHydrated: false,
          graphReconciling: true,
        });
        void get().reconcileGraph();
        break;
      case "index.progress": {
        indexTransportEpoch += 1;
        const payload = event.payload;
        set((state) => ({
          index: {
            phase: payload.phase,
            progress: payload.progress,
            filesIndexed: payload.filesIndexed,
            symbolsIndexed: payload.symbolsIndexed,
            edgesIndexed: payload.edgesIndexed,
            ...(payload.message ? { message: payload.message } : {}),
          },
          workspaceSummary:
            payload.summary ?? {
              ...state.workspaceSummary,
              indexedFileCount: payload.filesIndexed,
            },
        }));
        break;
      }
      case "graph.delta": {
        const state = get();
        const result = mergeRevisionedGraphDelta(
          state.nodes,
          state.edges,
          state.graphRevision,
          event.payload,
        );
        if (result.kind === "duplicate") break;
        if (result.kind === "gap") {
          void get().reconcileGraph();
          break;
        }
        graphTransportEpoch += 1;
        const paginationInvalidated =
          state.graphSourceTruncated || state.graphCursor !== undefined;
        const expansionCursors: Record<string, string | null> = {};
        const visibleState = visibleGraphState(
          result.nodes,
          result.edges,
          state.collapsedNodeIds,
          expansionCursors,
          paginationInvalidated ? true : state.graphSourceTruncated,
          state.evidenceForcedNodeIds,
        );
        set({
          nodes: visibleState.nodes,
          edges: result.edges,
          semanticVersion: state.semanticVersion + 1,
          graphRevision: result.revision,
          graphSourceTruncated: paginationInvalidated
            ? true
            : state.graphSourceTruncated,
          graphTruncated: visibleState.graphTruncated,
          graphCursor: paginationInvalidated
            ? undefined
            : state.graphCursor,
          expansionCursors,
        });
        void applySemanticLayout();
        if (paginationInvalidated) void get().reconcileGraph();
        break;
      }
      case "graph.snapshot": {
        const state = get();
        const graph = event.payload.graph;
        if (graph.revision < state.graphRevision) break;
        if (
          graph.revision === state.graphRevision &&
          state.remoteHydrated
        ) {
          break;
        }
        graphTransportEpoch += 1;
        const panels = state.nodes.filter((node) => node.type !== "semantic");
        const positions = new Map(
          state.nodes
            .filter((node) => node.type === "semantic")
            .map((node) => [node.id, node.position]),
        );
        const semanticNodes = graphRecordsToFlowNodes(graph.nodes).map(
          (node) => ({
            ...node,
            position: positions.get(node.id) ?? node.position,
          }),
        );
        const graphEdges = graphRecordsToFlowEdges(graph.edges);
        const expansionCursors: Record<string, string | null> = {};
        const visibleState = visibleGraphState(
          [...semanticNodes, ...panels] as WorkspaceNode[],
          graphEdges,
          state.collapsedNodeIds,
          expansionCursors,
          graph.truncated,
          state.evidenceForcedNodeIds,
        );
        set({
          nodes: visibleState.nodes,
          edges: graphEdges,
          semanticVersion: state.semanticVersion + 1,
          graphRevision: graph.revision,
          graphSourceTruncated: graph.truncated,
          graphTruncated: visibleState.graphTruncated,
          graphCursor: graph.cursor,
          expansionCursors,
        });
        void applySemanticLayout();
        break;
      }
      case "ask.event": {
        const askEvent = event.payload;
        const activeAsk = get();
        if (
          askEvent.threadId !== activeAsk.askThreadId ||
          askEvent.requestId !== activeAsk.activeAskRequestId
        ) {
          break;
        }
        askTransportEpoch += 1;
        if (askEvent.type === "started") {
          set({
            askMode: askEvent.mode,
            assistantThinking: true,
            assistantError: null,
          });
        } else if (askEvent.type === "text_delta") {
          set((state) => ({
            answer: state.answer + askEvent.delta,
            assistantThinking: true,
            assistantError: null,
          }));
        } else if (askEvent.type === "evidence") {
          get().playEvidencePath(askEvent.path);
        } else if (askEvent.type === "fallback") {
          set({
            askMode: "local",
            askProviderStatus: fallbackProviderStatus(askEvent.code),
            askNotice: askEvent.message,
            answer: askEvent.discardPartial ? "" : get().answer,
            assistantThinking: true,
            assistantError: null,
          });
        } else if (askEvent.type === "completed") {
          set((state) => {
            const content = askEvent.answer.trim();
            const evidence = askEvent.evidence;
            const hasResult = Boolean(content || askEvent.localResult);
            return {
              answer: "",
              askMode: askEvent.mode,
              conversation: hasResult
                ? [
                    ...state.conversation,
                    {
                      role: "assistant" as const,
                      content,
                      mode: askEvent.mode,
                      ...(evidence ? { evidence } : {}),
                      ...(askEvent.localResult
                        ? { localResult: askEvent.localResult }
                        : {}),
                    },
                  ]
                : state.conversation,
              assistantThinking: false,
              activeAskTurnId: null,
              activeAskRequestId: null,
              assistantError: null,
            };
          });
          if (
            askEvent.evidence &&
            !sameEvidencePath(get().evidencePath, askEvent.evidence)
          ) {
            get().playEvidencePath(askEvent.evidence);
          }
        } else if (askEvent.type === "error") {
          set({
            assistantThinking: false,
            activeAskTurnId: null,
            activeAskRequestId: null,
            assistantError: askEvent.message,
          });
        }
        break;
      }
      case "terminal.output":
        window.dispatchEvent(
          new CustomEvent("constelix:terminal-output", {
            detail: event.payload,
          }),
        );
        break;
      case "terminal.exit": {
        terminalTransportEpoch += 1;
        const terminalId = event.payload.terminalId;
        const exitLabel = `proceso terminado: ${event.payload.exitCode ?? event.payload.signal ?? "desconocido"}`;
        set((state) => ({
          terminalRuntimes: markTerminalRuntimeExited(
            state.terminalRuntimes,
            terminalId,
            exitLabel,
          ),
        }));
        window.dispatchEvent(
          new CustomEvent("constelix:terminal-output", {
            detail: {
              terminalId,
              data: `\r\n\u001b[90m[${exitLabel}]\u001b[0m\r\n`,
            },
          }),
        );
        break;
      }
      case "capabilities.updated": {
        const askUpdated =
          event.payload.askMode !== undefined ||
          event.payload.askProviderStatus !== undefined ||
          event.payload.askNotice !== undefined;
        const codexUpdated =
          event.payload.act !== undefined ||
          event.payload.checking !== undefined ||
          event.payload.codexReason !== undefined ||
          event.payload.codexVersion !== undefined;
        if (askUpdated) askCapabilityTransportEpoch += 1;
        if (codexUpdated) actCapabilityTransportEpoch += 1;
        set((state) => ({
          askMode: event.payload.askMode ?? state.askMode,
          askProviderStatus:
            event.payload.askProviderStatus ?? state.askProviderStatus,
          askNotice:
            event.payload.askNotice === undefined
              ? state.askNotice
              : event.payload.askNotice ?? undefined,
          actAvailable:
            event.payload.act === undefined
              ? state.actAvailable
              : state.workspaceMode === "edit" && event.payload.act,
          codexReason: !codexUpdated
            ? state.codexReason
            : event.payload.checking
              ? "Comprobando compatibilidad con Codex CLI…"
              : state.workspaceMode === "read"
                ? "Actuar está deshabilitado en Modo Lectura."
                : event.payload.codexReason,
          codexChecking:
            event.payload.checking ?? state.codexChecking,
          codexVersion:
            event.payload.codexVersion ?? state.codexVersion,
        }));
        break;
      }
      case "act.event": {
        const activeTask = get().actTask;
        if (!activeTask || activeTask.id !== event.payload.taskId) break;
        actTransportEpoch += 1;
        set((state) => {
          const payload = event.payload;
          const taskId = payload.taskId;
          if (!state.actTask || state.actTask.id !== taskId) return state;
          const rawStatus = payload.status;
          const mappedStatus = rawStatus
            ? toViewTaskStatus(rawStatus as ActTaskStatus)
            : state.actTask.status;
          const status =
            state.actTask.status === "cancelling" &&
            mappedStatus === "running"
              ? "cancelling"
              : mappedStatus;
          const message = payload.message ?? payload.event;
          return {
            actTask: {
              ...state.actTask,
              status,
              output: [...state.actTask.output, message],
            },
          };
        });
        break;
      }
      case "error":
        set((state) => ({
          notices: [
            ...state.notices.filter(
              (notice) => notice.code !== event.payload.code,
            ),
            {
              id: event.eventId,
              code: event.payload.code,
              message: event.payload.message,
              severity: event.payload.severity,
              recoverable: event.payload.recoverable,
            },
          ].slice(-4),
        }));
        break;
      default:
        break;
    }
  },

  selectNode: (selectedNodeId) => set({ selectedNodeId }),

  raisePanel: (id) => {
    set((state) => {
      const panel = state.nodes.find(
        (node) => node.id === id && node.type !== "semantic",
      );
      if (!panel) return state;
      const activeTool =
        panel.type === "editorPanel"
          ? "editor"
          : panel.type === "terminalPanel"
            ? "terminal"
            : "ai";
      return {
        activeTool,
        nodes: state.nodes.map((node) =>
          node.id === id
            ? { ...node, zIndex: nextToolPanelZIndex(state.nodes) }
            : node,
        ) as WorkspaceNode[],
      };
    });
    get().saveLayout();
  },

  openFile: (relativePath, anchorNodeId) => {
    set((state) => ({
      activeTool: "editor",
      nodes: state.nodes.map((node) => {
        if (node.id !== "panel-editor" || node.type !== "editorPanel") return node;
        const { anchorNodeId: _anchorNodeId, ...data } = node.data;
        return {
          ...node,
          hidden: false,
          zIndex: nextToolPanelZIndex(state.nodes),
          data: {
            ...data,
            title: `Editor — ${relativePath.split("/").at(-1) ?? relativePath}`,
            relativePath,
            language: relativePath.endsWith(".py")
              ? "python"
              : "typescript",
            ...(anchorNodeId ? { anchorNodeId } : {}),
          },
        };
      }) as WorkspaceNode[],
    }));
    get().saveLayout();
  },

  openTerminal: (cwd = ".", anchorNodeId) => {
    const runtime = get().terminalRuntimes["panel-terminal"];
    if (runtime && runtime.cwd !== cwd) {
      void apiClient.deleteTerminal(runtime.terminalId).catch(() => undefined);
      get().clearTerminalRuntime("panel-terminal");
    }
    set((state) => ({
      activeTool: "terminal",
      nodes: state.nodes.map((node) => {
        if (node.id !== "panel-terminal" || node.type !== "terminalPanel") {
          return node;
        }
        const { anchorNodeId: _anchorNodeId, ...data } = node.data;
        return {
          ...node,
          hidden: false,
          zIndex: nextToolPanelZIndex(state.nodes),
          data: {
            ...data,
            title: `Terminal — ${cwd}`,
            cwd,
            ...(anchorNodeId ? { anchorNodeId } : {}),
          },
        };
      }) as WorkspaceNode[],
    }));
    get().saveLayout();
  },

  createTerminal: (cwd = ".", anchorNodeId, dock = "bottom") => {
    set((state) => {
      const terminals = state.nodes.filter(
        (node): node is TerminalFlowNode => node.type === "terminalPanel",
      );
      const last = terminals.at(-1);
      const terminal: TerminalFlowNode = {
        id: `panel-terminal-${crypto.randomUUID()}`,
        type: "terminalPanel",
        position: {
          x: (last?.position.x ?? 40) + 34,
          y: (last?.position.y ?? 510) + 34,
        },
        style: { width: 410, height: 310 },
        dragHandle: ".panel-titlebar",
        data: {
          panelType: "terminal",
          dock,
          title: `Terminal — ${cwd}`,
          cwd,
          ...(anchorNodeId ? { anchorNodeId } : {}),
        },
        zIndex: nextToolPanelZIndex(state.nodes),
      };
      return { activeTool: "terminal", nodes: [...state.nodes, terminal] };
    });
    get().saveLayout();
  },

  registerTerminalRuntime: (panelId, runtime) => {
    terminalTransportEpoch += 1;
    set((state) => ({
      terminalRuntimes: {
        ...state.terminalRuntimes,
        [panelId]: runtime,
      },
    }));
  },

  clearTerminalRuntime: (panelId) => {
    terminalTransportEpoch += 1;
    set((state) => {
      const { [panelId]: _removed, ...terminalRuntimes } =
        state.terminalRuntimes;
      return { terminalRuntimes };
    });
  },

  expandNode: async (nodeId) => {
    if (get().demoMode) return;
    const stateBeforeQuery = get();
    const cursors = stateBeforeQuery.expansionCursors;
    if (
      Object.prototype.hasOwnProperty.call(cursors, nodeId) &&
      cursors[nodeId] === null
    ) {
      return;
    }
    try {
      const snapshot = await apiClient.queryGraph(
        [nodeId],
        cursors[nodeId] ?? undefined,
      );
      if (
        snapshot.revision !== stateBeforeQuery.graphRevision ||
        get().graphRevision !== stateBeforeQuery.graphRevision
      ) {
        await get().reconcileGraph();
        return;
      }
      set((state) => {
        const anchor = state.nodes.find((node) => node.id === nodeId);
        const existingIds = new Set(state.nodes.map((node) => node.id));
        const incoming = graphRecordsToFlowNodes(snapshot.nodes);
        const updates = new Map(incoming.map((node) => [node.id, node]));
        let addedIndex = 0;
        const added = incoming
          .filter((node) => !existingIds.has(node.id))
          .map((node) => {
            const index = addedIndex++;
            return {
              ...node,
              position: anchor
                ? {
                    x: anchor.position.x + 190 + (index % 3) * 175,
                    y:
                      anchor.position.y +
                      (Math.floor(index / 3) - 1) * 82,
                  }
                : node.position,
            };
          });
        const edgeUpdates = new Map(
          graphRecordsToFlowEdges(snapshot.edges).map((edge) => [
            edge.id,
            edge,
          ]),
        );
        const existingEdgeIds = new Set(state.edges.map((edge) => edge.id));
        const collapsedNodeIds = {
          ...state.collapsedNodeIds,
          [nodeId]: false,
        };
        const expansionCursors = {
          ...state.expansionCursors,
          [nodeId]: snapshot.cursor ?? null,
        };
        const mergedNodes = [
          ...state.nodes.map((node) => {
            const update = updates.get(node.id);
            return update && node.type === "semantic"
              ? {
                  ...update,
                  position: node.position,
                  data: { ...update.data, ...node.data },
                }
              : node;
          }),
          ...added,
        ] as WorkspaceNode[];
        const mergedEdges = [
          ...state.edges.map((edge) => edgeUpdates.get(edge.id) ?? edge),
          ...[...edgeUpdates.values()].filter(
            (edge) => !existingEdgeIds.has(edge.id),
          ),
        ];
        const visibleState = visibleGraphState(
          mergedNodes,
          mergedEdges,
          collapsedNodeIds,
          expansionCursors,
          state.graphSourceTruncated,
          state.evidenceForcedNodeIds,
        );
        return {
          expansionCursors,
          collapsedNodeIds,
          nodes: visibleState.nodes,
          edges: mergedEdges,
          semanticVersion: state.semanticVersion + 1,
          graphTruncated: visibleState.graphTruncated,
        };
      });
      void applySemanticLayout();
    } catch (error) {
      set({
        assistantError:
          error instanceof Error
            ? error.message
            : "No se pudo expandir el nodo.",
      });
    }
  },

  loadNextGraphPage: async () => {
    const stateBeforeQuery = get();
    const cursor = stateBeforeQuery.graphCursor;
    if (!cursor || stateBeforeQuery.demoMode || stateBeforeQuery.graphReconciling) {
      return;
    }
    set({ graphReconciling: true });
    try {
      const snapshot = await apiClient.queryGraphPage(cursor);
      if (
        snapshot.revision !== stateBeforeQuery.graphRevision ||
        get().graphRevision !== stateBeforeQuery.graphRevision
      ) {
        set({ graphReconciling: false });
        await get().reconcileGraph();
        return;
      }
      const state = get();
      const merged = mergeGraphSnapshotPage(
        state.nodes,
        state.edges,
        snapshot,
      );
      const visibleState = visibleGraphState(
        merged.nodes,
        merged.edges,
        state.collapsedNodeIds,
        state.expansionCursors,
        snapshot.truncated,
        state.evidenceForcedNodeIds,
      );
      set({
        nodes: visibleState.nodes,
        edges: merged.edges,
        semanticVersion: state.semanticVersion + 1,
        graphRevision: snapshot.revision,
        graphSourceTruncated: snapshot.truncated,
        graphTruncated: visibleState.graphTruncated,
        graphCursor: snapshot.cursor,
        graphReconciling: false,
      });
      void applySemanticLayout();
    } catch (error) {
      set({
        graphReconciling: false,
        assistantError:
          error instanceof Error
            ? error.message
            : "No se pudo cargar la siguiente página del grafo.",
      });
    }
  },

  activateSemanticNode: async (nodeId) => {
    const node = get().nodes.find(
      (candidate) => candidate.id === nodeId && candidate.type === "semantic",
    );
    if (!node || node.type !== "semantic") return;
    const hierarchy =
      node.data.kind === "workspace" ||
      node.data.kind === "directory" ||
      node.data.kind === "module";
    if (!hierarchy) {
      if (node.data.relativePath) {
        get().openFile(node.data.relativePath, node.id);
      }
      if (!get().demoMode) await get().expandNode(nodeId);
      return;
    }

    const queried = Object.prototype.hasOwnProperty.call(
      get().expansionCursors,
      nodeId,
    );
    if (get().collapsedNodeIds[nodeId]) {
      get().toggleSemanticCollapse(nodeId);
      if (!queried || typeof get().expansionCursors[nodeId] === "string") {
        await get().expandNode(nodeId);
      }
      return;
    }
    if (!queried || typeof get().expansionCursors[nodeId] === "string") {
      await get().expandNode(nodeId);
      return;
    }
    get().toggleSemanticCollapse(nodeId);
  },

  toggleSemanticCollapse: (nodeId) => {
    set((state) => {
      const collapsedNodeIds = {
        ...state.collapsedNodeIds,
        [nodeId]: !state.collapsedNodeIds[nodeId],
      };
      const visibleState = visibleGraphState(
        state.nodes,
        state.edges,
        collapsedNodeIds,
        state.expansionCursors,
        state.graphSourceTruncated,
        state.evidenceForcedNodeIds,
      );
      return {
        collapsedNodeIds,
        nodes: visibleState.nodes,
        graphTruncated: visibleState.graphTruncated,
      };
    });
    get().saveLayout();
  },

  setCanvasZoom: (zoom) => {
    const compactMode = zoom < 0.65;
    if (get().compactMode !== compactMode) set({ compactMode });
  },

  setNodeKindFilter: (nodeKind) =>
    set((state) => ({
      canvasFilters: { ...state.canvasFilters, nodeKind },
    })),

  setExtensionFilter: (extension) =>
    set((state) => ({
      canvasFilters: { ...state.canvasFilters, extension },
    })),

  resetCanvasFilters: () =>
    set({ canvasFilters: { nodeKind: "all", extension: "all" } }),

  acknowledgeOnboarding: () => set({ onboardingOpen: false }),

  dismissNotice: (id) =>
    set((state) => ({
      notices: state.notices.filter((notice) => notice.id !== id),
    })),

  setActiveTool: (tool) => {
    set({ activeTool: tool });
    if (tool === "map") {
      window.dispatchEvent(new Event("constelix:fit-graph"));
    }
    if (tool === "files" || tool === "editor") {
      get().togglePanel("panel-editor", true);
    }
    if (tool === "terminal") get().togglePanel("panel-terminal", true);
    if (tool === "ai") get().togglePanel("panel-assistant", true);
  },

  setCommandPaletteOpen: (commandPaletteOpen) =>
    set({ commandPaletteOpen }),

  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  togglePanel: (id, visible) => {
    set((state) => {
      const zIndex = nextToolPanelZIndex(state.nodes);
      return {
        nodes: state.nodes.map((node) => {
          if (node.id !== id) return node;
          const hidden = visible === undefined ? !node.hidden : !visible;
          return {
            ...node,
            hidden,
            ...(node.type !== "semantic" && !hidden ? { zIndex } : {}),
          };
        }) as WorkspaceNode[],
      };
    });
    get().saveLayout();
  },

  setPanelDock: (id, dock) => {
    set((state) => {
      const zIndex = nextToolPanelZIndex(state.nodes);
      const panel = state.nodes.find(
        (node) => node.id === id && node.type !== "semantic",
      );
      if (!panel) return state;
      const activeTool =
        panel.type === "editorPanel"
          ? "editor"
          : panel.type === "terminalPanel"
            ? "terminal"
            : "ai";
      return {
        activeTool,
        nodes: state.nodes.map((node) => {
          if (node.id !== id || node.type === "semantic") return node;
          return {
            ...node,
            hidden: false,
            zIndex,
            data: {
              ...node.data,
              dock,
              ...(dock === "floating" ? {} : { collapsed: false }),
            },
          } as WorkspaceNode;
        }),
      };
    });
    get().saveLayout();
  },

  closePanel: (id) => {
    const runtime = get().terminalRuntimes[id];
    if (runtime) {
      void apiClient.deleteTerminal(runtime.terminalId).catch(() => undefined);
      get().clearTerminalRuntime(id);
    }
    set((state) => ({
      nodes:
        id.startsWith("panel-terminal-")
          ? state.nodes.filter((node) => node.id !== id)
          : state.nodes.map((node) =>
              node.id === id ? { ...node, hidden: true } : node,
            ),
    }));
    get().saveLayout();
  },

  setPanelCollapsed: (id, collapsed, expandedHeight) => {
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === id && node.type !== "semantic"
          ? {
              ...node,
              style: {
                ...node.style,
                height: collapsed ? 42 : expandedHeight,
              },
              data: {
                ...node.data,
                collapsed,
                expandedHeight,
              },
            }
          : node,
      ) as WorkspaceNode[],
    }));
    get().saveLayout();
  },

  updateEditorPanel: (patch) =>
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === "panel-editor"
          ? ({
              ...node,
              data: { ...node.data, ...patch },
            } as WorkspaceNode)
          : node,
      ),
    })),

  updateTerminalPanel: (patch) =>
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === "panel-terminal"
          ? ({
              ...node,
              data: { ...node.data, ...patch },
            } as WorkspaceNode)
          : node,
      ),
    })),

  setAssistantMode: (assistantMode) => {
    set((state) => ({
      assistantMode,
      nodes: state.nodes.map((node) =>
        node.id === "panel-assistant"
          ? ({
              ...node,
              data: { ...node.data, mode: assistantMode },
            } as WorkspaceNode)
          : node,
      ),
    }));
    get().saveLayout();
  },

  setQuestion: (question) => set({ question }),

  submitQuestion: async () => {
    const state = get();
    const prompt = state.question.trim();
    const workspaceReady = canUseWorkspaceFeatures(state);
    if (
      !workspaceReady ||
      !state.askAvailable ||
      !prompt ||
      state.assistantThinking
    ) {
      return;
    }
    const requestId = state.demoMode ? null : crypto.randomUUID();
    const visibleState = visibleGraphState(
      state.nodes,
      state.edges,
      state.collapsedNodeIds,
      state.expansionCursors,
      state.graphSourceTruncated,
    );
    set({
      nodes: visibleState.nodes,
      graphTruncated: visibleState.graphTruncated,
      question: "",
      answer: "",
      conversation: [
        ...(state.demoMode ? [] : state.conversation),
        { role: "user", content: prompt },
      ],
      assistantThinking: true,
      activeAskRequestId: requestId,
      assistantError: null,
      evidencePath: null,
      evidenceCursor: 0,
      evidencePartial: false,
      evidenceForcedNodeIds: {},
    });

    if (get().demoMode) {
      window.setTimeout(() => {
        const demoAnswer =
          "La consulta entra por `/api/query`, pasa por `query.handler.ts` y `QueryService`. Después, `GraphIndexer` consulta `ProjectGraph`, mientras `LocalAgentService` mantiene el índice actualizado.";
        set({
          answer: "",
          conversation: [
            ...get().conversation,
            {
              role: "assistant",
              content: demoAnswer,
              evidence: demoEvidencePath,
            },
          ],
          assistantThinking: false,
        });
        get().playEvidencePath(demoEvidencePath);
      }, 680);
      return;
    }

    try {
      const selectedNodeId = get().selectedNodeId;
      const turn = await apiClient.ask(
        get().askThreadId,
        prompt,
        selectedNodeId ? [selectedNodeId] : [],
        requestId ?? undefined,
      );
      if (get().activeAskRequestId === requestId) {
        set({ activeAskTurnId: turn.turnId });
      }
    } catch (error) {
      if (get().activeAskRequestId === requestId) {
        set({
          assistantThinking: false,
          activeAskTurnId: null,
          activeAskRequestId: null,
          assistantError:
            error instanceof Error
              ? error.message
              : "No se pudo consultar al agente.",
        });
      }
    }
  },

  cancelQuestion: () => {
    const turnId = get().activeAskTurnId;
    if (!turnId) return;
    apiClient.sendEvent({ type: "ask.cancel", turnId });
  },

  playEvidencePath: (evidencePath) => {
    if (evidenceTimer !== null) window.clearInterval(evidenceTimer);
    const state = get();
    const loadedIds = new Set(
      state.nodes
        .filter((node) => node.type === "semantic")
        .map((node) => node.id),
    );
    const missingNodeIds = evidencePath.nodeIds.filter(
      (nodeId) => !loadedIds.has(nodeId),
    );
    const loadedEdgeIds = new Set(state.edges.map((edge) => edge.id));
    const hasMissingEdges = evidencePath.edgeIds.some(
      (edgeId) => !loadedEdgeIds.has(edgeId),
    );
    const evidenceForcedNodeIds = Object.fromEntries(
      evidencePath.nodeIds
        .filter((nodeId) => loadedIds.has(nodeId))
        .map((nodeId) => [nodeId, true]),
    );
    const visibleState = visibleGraphState(
      state.nodes,
      state.edges,
      state.collapsedNodeIds,
      state.expansionCursors,
      state.graphSourceTruncated,
      evidenceForcedNodeIds,
    );
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reducedMotion) {
      set({
        nodes: visibleState.nodes,
        graphTruncated: visibleState.graphTruncated,
        evidencePath,
        evidenceCursor: evidencePath.nodeIds.length,
        evidencePartial: missingNodeIds.length > 0 || hasMissingEdges,
        evidenceForcedNodeIds,
      });
    } else {
      set({
        nodes: visibleState.nodes,
        graphTruncated: visibleState.graphTruncated,
        evidencePath,
        evidenceCursor: 1,
        evidencePartial: missingNodeIds.length > 0 || hasMissingEdges,
        evidenceForcedNodeIds,
      });
      evidenceTimer = window.setInterval(() => {
        const next = get().evidenceCursor + 1;
        if (next >= evidencePath.nodeIds.length) {
          set({
            evidenceCursor: evidencePath.nodeIds.length,
          });
          if (evidenceTimer !== null) window.clearInterval(evidenceTimer);
          evidenceTimer = null;
          return;
        }
        set({ evidenceCursor: next });
      }, 440);
    }
    window.requestAnimationFrame(() => {
      window.dispatchEvent(
        new CustomEvent("constelix:focus-evidence", {
          detail: evidencePath.nodeIds.filter((nodeId) => loadedIds.has(nodeId)),
        }),
      );
    });

    if (
      (missingNodeIds.length > 0 || hasMissingEdges) &&
      !state.demoMode
    ) {
      void recoverEvidenceGraph(evidencePath);
    }
  },

  navigateEvidence: async (nodeId) => {
    let node = get().nodes.find((candidate) => candidate.id === nodeId);
    if (!node && !get().demoMode) {
      await get().expandNode(nodeId);
      node = get().nodes.find((candidate) => candidate.id === nodeId);
    }
    get().selectNode(nodeId);
    if (
      !node ||
      node.type !== "semantic" ||
      !node.data.relativePath ||
      node.data.kind === "directory"
    ) {
      return;
    }
    const evidence = get().evidencePath?.evidence.find(
      (item) => item.relativePath === node.data.relativePath,
    );
    get().openFile(node.data.relativePath, nodeId);
    const revealLine =
      evidence?.range.start.line ??
      node.data.range?.start.line;
    if (revealLine !== undefined) {
      get().updateEditorPanel({
        revealLine: revealLine + 1,
      });
    }
  },

  createActTask: async () => {
    const state = get();
    const objective = state.question.trim();
    const workspaceReady = canUseWorkspaceFeatures(state);
    if (
      !workspaceReady ||
      state.workspaceMode === "read" ||
      !objective ||
      !state.actAvailable
    ) return;
    if (state.demoMode) {
      actTransportEpoch += 1;
      set({
        actTask: {
          id: crypto.randomUUID(),
          objective,
          status: "awaitingApproval",
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          output: [],
        },
      });
      return;
    }
    try {
      const task = await apiClient.createActTask(objective);
      actTransportEpoch += 1;
      set({
        actTask: {
          id: task.id,
          objective: task.scope.objective,
          status: toViewTaskStatus(task.status),
          expiresAt: task.scope.expiresAt,
          output: [],
        },
      });
    } catch (error) {
      set({
        assistantError:
          error instanceof Error
            ? error.message
            : "No se pudo crear la tarea.",
      });
    }
  },

  approveActTask: async () => {
    const state = get();
    const task = state.actTask;
    if (!task || task.status !== "awaitingApproval") return;
    if (
      !state.demoMode &&
      (!state.remoteHydrated ||
        state.connection !== "connected" ||
        state.workspaceMode === "read" ||
        !state.actAvailable)
    ) {
      return;
    }
    actTransportEpoch += 1;
    set({
      actTask: {
        ...task,
        status: "running",
        output: ["Tarea aprobada. Iniciando Codex App Server…"],
      },
    });
    if (get().demoMode) {
      window.setTimeout(
        () =>
          set((state) => ({
            actTask: state.actTask
              ? {
                  ...state.actTask,
                  status: "completed",
                  output: [
                    ...state.actTask.output,
                    "Simulación completada; no se modificó el workspace.",
                  ],
                }
              : null,
          })),
        950,
      );
      return;
    }
    try {
      await apiClient.approveActTask(task.id);
    } catch (error) {
      set({
        actTask: {
          ...task,
          status: "failed",
          output: [
            error instanceof Error ? error.message : "La aprobación falló.",
          ],
        },
      });
    }
  },

  cancelActTask: async () => {
    const task = get().actTask;
    if (!task) return;
    actTransportEpoch += 1;
    if (get().demoMode) {
      set({ actTask: { ...task, status: "cancelled" } });
      return;
    }
    set({
      actTask: {
        ...task,
        status: "cancelling",
        output: [
          ...task.output,
          "Cancelación solicitada; esperando confirmación de Codex…",
        ],
      },
    });
    try {
      const cancelled = await apiClient.cancelActTask(task.id);
      set((state) => {
        if (!state.actTask || state.actTask.id !== task.id) return state;
        const mapped = toViewTaskStatus(cancelled.status);
        return {
          actTask: {
            ...state.actTask,
            status: mapped === "running" ? "cancelling" : mapped,
          },
        };
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "No se pudo solicitar la cancelación.";
      set((state) => {
        if (!state.actTask || state.actTask.id !== task.id) return state;
        return {
          actTask: {
            ...state.actTask,
            status: task.status,
            output: [...state.actTask.output, message],
          },
          assistantError: message,
        };
      });
    }
  },

  resetActTask: () => {
    actTransportEpoch += 1;
    set({ actTask: null, assistantError: null });
  },

  saveLayout: () => {
    if (layoutTimer !== null) window.clearTimeout(layoutTimer);
    if (get().demoMode) return;
    layoutTimer = window.setTimeout(() => {
      layoutTimer = null;
      const state = get();
      void apiClient.saveLayout(serializeWorkspaceLayout({
        nodes: state.nodes,
        assistantMode: state.assistantMode,
        collapsedNodeIds: state.collapsedNodeIds,
        pinnedSemanticNodeIds: state.pinnedSemanticNodeIds,
      })).catch(() => undefined);
    }, 0);
  },

  flushLayout: () => {
    if (get().demoMode) return;
    if (layoutTimer !== null) {
      window.clearTimeout(layoutTimer);
      layoutTimer = null;
    }
    const state = get();
    void apiClient.saveLayout(serializeWorkspaceLayout({
      nodes: state.nodes,
      assistantMode: state.assistantMode,
      collapsedNodeIds: state.collapsedNodeIds,
      pinnedSemanticNodeIds: state.pinnedSemanticNodeIds,
    }), true).catch(() => undefined);
  },

  saveLayoutNow: async () => {
    if (get().demoMode) return;
    if (layoutTimer !== null) {
      window.clearTimeout(layoutTimer);
      layoutTimer = null;
    }
    const state = get();
    await apiClient.saveLayout(serializeWorkspaceLayout({
      nodes: state.nodes,
      assistantMode: state.assistantMode,
      collapsedNodeIds: state.collapsedNodeIds,
      pinnedSemanticNodeIds: state.pinnedSemanticNodeIds,
    }));
  },
}));

async function recoverEvidenceGraph(
  evidencePath: EvidencePath,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = useWorkspaceStore.getState();
    const missing = missingEvidence(before, evidencePath);
    if (missing.nodeIds.length === 0 && missing.edgeIds.length === 0) return;

    try {
      const snapshot = await apiClient.queryEvidenceGraph(
        evidencePath.nodeIds,
      );
      const current = useWorkspaceStore.getState();
      if (!sameEvidencePath(current.evidencePath, evidencePath)) return;
      if (
        snapshot.revision !== before.graphRevision ||
        current.graphRevision !== before.graphRevision
      ) {
        await current.reconcileGraph();
        return;
      }
      const merged = mergeGraphSnapshotPage(
        current.nodes,
        current.edges,
        snapshot,
      );
      const loadedIds = new Set(
        merged.nodes
          .filter((node) => node.type === "semantic")
          .map((node) => node.id),
      );
      const loadedEdgeIds = new Set(merged.edges.map((edge) => edge.id));
      const evidenceForcedNodeIds = Object.fromEntries(
        evidencePath.nodeIds
          .filter((nodeId) => loadedIds.has(nodeId))
          .map((nodeId) => [nodeId, true]),
      );
      const visibleState = visibleGraphState(
        merged.nodes,
        merged.edges,
        current.collapsedNodeIds,
        current.expansionCursors,
        current.graphSourceTruncated,
        evidenceForcedNodeIds,
      );
      useWorkspaceStore.setState({
        nodes: visibleState.nodes,
        edges: merged.edges,
        graphTruncated: visibleState.graphTruncated,
        evidencePartial:
          evidencePath.nodeIds.some((nodeId) => !loadedIds.has(nodeId)) ||
          evidencePath.edgeIds.some((edgeId) => !loadedEdgeIds.has(edgeId)),
        evidenceForcedNodeIds,
      });
      void applySemanticLayout();
    } catch {
      return;
    }
  }
}

function missingEvidence(
  state: Pick<WorkspaceState, "nodes" | "edges">,
  evidencePath: EvidencePath,
): { nodeIds: string[]; edgeIds: string[] } {
  const nodeIds = new Set(
    state.nodes
      .filter((node) => node.type === "semantic")
      .map((node) => node.id),
  );
  const edgeIds = new Set(state.edges.map((edge) => edge.id));
  return {
    nodeIds: evidencePath.nodeIds.filter((nodeId) => !nodeIds.has(nodeId)),
    edgeIds: evidencePath.edgeIds.filter((edgeId) => !edgeIds.has(edgeId)),
  };
}

async function applySemanticLayout(): Promise<void> {
  const state = useWorkspaceStore.getState();
  const requestEpoch = ++layoutRequestEpoch;
  const workspaceId = state.workspaceId;
  const graphRevision = state.graphRevision;
  const semanticVersion = state.semanticVersion;
  try {
    const positions = await layoutSemanticNodes(state.nodes, state.edges);
    const current = useWorkspaceStore.getState();
    if (
      requestEpoch !== layoutRequestEpoch ||
      current.workspaceId !== workspaceId ||
      current.graphRevision !== graphRevision ||
      current.semanticVersion !== semanticVersion
    ) {
      return;
    }
    const pinnedNodeIds = new Set(
      Object.entries(current.pinnedSemanticNodeIds)
        .filter(([, pinned]) => pinned)
        .map(([id]) => id),
    );
    const collisionFree = resolveSemanticLayoutCollisions(
      current.nodes.filter(isFloatingCanvasNode),
      positions,
      pinnedNodeIds,
    );
    useWorkspaceStore.setState((current) => ({
      nodes: current.nodes.map((node) => {
        if (
          node.type !== "semantic" ||
          current.pinnedSemanticNodeIds[node.id]
        ) {
          return node;
        }
        const position = collisionFree[node.id];
        return position ? { ...node, position } : node;
      }) as WorkspaceNode[],
    }));
  } catch {
    // The deterministic column layout remains usable if the layout worker fails.
  }
}

function fallbackProviderStatus(code: string): WorkspaceAskProviderStatus {
  switch (code) {
    case "INSUFFICIENT_QUOTA":
      return "insufficient_quota";
    case "INVALID_API_KEY":
      return "invalid_api_key";
    case "RATE_LIMITED":
      return "rate_limited";
    case "NETWORK_UNAVAILABLE":
      return "network_unavailable";
    default:
      return "unavailable";
  }
}

function isTransientBootstrapError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof AgentRequestError &&
      (error.status === 408 ||
        error.status === 429 ||
        (error.status === 409 &&
          (error.code === "WORKSPACE_SWITCH_IN_PROGRESS" ||
            error.code === "WORKSPACE_SESSION_CHANGED")) ||
        error.status >= 500))
  );
}

function toViewActTask(task: ContractActTask): ActTask {
  const status = toViewTaskStatus(task.status);
  const output =
    status === "running"
      ? ["Tarea activa recuperada desde el agente local."]
      : [];
  return {
    id: task.id,
    objective: task.scope.objective,
    status,
    expiresAt: task.scope.expiresAt,
    output,
  };
}

function reconcileActTask(
  previous: ActTask | null,
  restored: ActTask | null,
  preserveTransportState: boolean,
  preserveSessionState: boolean,
): ActTask | null {
  if (preserveTransportState) return previous;
  if (previous && restored && previous.id === restored.id) {
    return {
      ...restored,
      status:
        previous.status === "cancelling"
          ? "cancelling"
          : restored.status,
      output:
        previous.output.length > 0
          ? previous.output
          : restored.output,
    };
  }
  if (
    !restored &&
    preserveSessionState &&
    previous &&
    (previous.status === "completed" ||
      previous.status === "cancelled" ||
      previous.status === "failed")
  ) {
    return previous;
  }
  return restored;
}

function toViewTaskStatus(
  status: ActTaskStatus | string,
): ActTask["status"] {
  switch (status) {
    case "awaitingApproval":
    case "pending_approval":
      return "awaitingApproval";
    case "approved":
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "cancelled":
    case "expired":
      return "cancelled";
    case "failed":
      return "failed";
    default:
      return "draft";
  }
}
