import { applyEdgeChanges, applyNodeChanges, type EdgeChange, type NodeChange } from "@xyflow/react";
import { create } from "zustand";
import type { ActTaskStatus, PanelKind, PanelState } from "@constelix/contracts";

import { demoEdges, demoEvidencePath, demoIndexStatus, demoNodes } from "../data/demo";
import { apiClient } from "../lib/api";
import { graphRecordsToFlowEdges, graphRecordsToFlowNodes } from "../lib/graph";
import { layoutSemanticNodes } from "../lib/layout";
import { markTerminalRuntimeExited } from "../lib/terminalRuntime";
import {
  applySemanticViewState,
  hasCapacityHiddenNodes,
  mergeRevisionedGraphDelta,
} from "../lib/workspaceGraph";
import type {
  ActTask,
  AgentEvent,
  AssistantMode,
  BootstrapPayload,
  ConnectionState,
  EditorPanelData,
  EvidencePath,
  IndexStatus,
  RailTool,
  TerminalFlowNode,
  TerminalPanelData,
  TerminalRuntime,
  WorkspaceEdge,
  WorkspaceNode,
} from "../types";

interface WorkspaceState {
  workspaceName: string;
  askThreadId: string;
  rootPath: string;
  branch: string;
  connection: ConnectionState;
  demoMode: boolean;
  activeTool: RailTool;
  commandPaletteOpen: boolean;
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
  compactMode: boolean;
  terminalRuntimes: Record<string, TerminalRuntime>;
  index: IndexStatus;
  assistantMode: AssistantMode;
  question: string;
  answer: string;
  assistantError: string | null;
  assistantThinking: boolean;
  activeAskTurnId: string | null;
  evidencePath: EvidencePath | null;
  evidenceCursor: number;
  evidencePartial: boolean;
  evidenceForcedNodeIds: Record<string, boolean>;
  actTask: ActTask | null;
  actAvailable: boolean;
  codexReason: string | undefined;
  onNodesChange: (changes: NodeChange<WorkspaceNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<WorkspaceEdge>[]) => void;
  setConnection: (connection: ConnectionState) => void;
  hydrateBootstrap: (payload: BootstrapPayload) => void;
  reconcileGraph: () => Promise<void>;
  handleAgentEvent: (event: AgentEvent) => void;
  selectNode: (id: string | null) => void;
  raisePanel: (id: string) => void;
  openFile: (relativePath: string, anchorNodeId?: string) => void;
  openTerminal: (cwd?: string, anchorNodeId?: string) => void;
  createTerminal: (cwd?: string, anchorNodeId?: string) => void;
  registerTerminalRuntime: (panelId: string, runtime: TerminalRuntime) => void;
  clearTerminalRuntime: (panelId: string) => void;
  expandNode: (nodeId: string) => Promise<void>;
  activateSemanticNode: (nodeId: string) => Promise<void>;
  toggleSemanticCollapse: (nodeId: string) => void;
  setCanvasZoom: (zoom: number) => void;
  setActiveTool: (tool: RailTool) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  togglePanel: (id: string, visible?: boolean) => void;
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
}

let evidenceTimer: number | null = null;
let layoutTimer: number | null = null;
let reconcilePromise: Promise<void> | null = null;

function collapsedSet(collapsedNodeIds: Readonly<Record<string, boolean>>): Set<string> {
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

function withLayout(nodes: WorkspaceNode[], layout: NonNullable<BootstrapPayload["layout"]>): WorkspaceNode[] {
  const lookup = new Map(layout.map((item) => [item.id, item]));
  return nodes.map((node) => {
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
        position: saved.position,
      };
    }
    return {
      ...node,
      hidden: saved.resource.hidden === true,
      data: {
        ...node.data,
        ...resource,
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
  workspaceName: "constelix",
  askThreadId: "workspace-main",
  rootPath: "~/Proyectos/constelix",
  branch: "main",
  connection: "connecting",
  demoMode: !apiClient.hasToken,
  activeTool: "map",
  commandPaletteOpen: false,
  nodes: demoNodes,
  edges: demoEdges,
  graphRevision: 0,
  graphSourceTruncated: false,
  graphTruncated: false,
  graphCursor: undefined,
  graphReconciling: false,
  remoteHydrated: false,
  selectedNodeId: "fn-indexer",
  expansionCursors: {},
  collapsedNodeIds: {},
  compactMode: false,
  terminalRuntimes: {},
  index: demoIndexStatus,
  assistantMode: "ask",
  question: "¿Cómo llega una consulta al grafo?",
  answer:
    "La consulta entra por `/api/query`, pasa por `query.handler.ts` y `QueryService`. Después, `GraphIndexer` consulta `ProjectGraph`.",
  assistantError: null,
  assistantThinking: false,
  activeAskTurnId: null,
  evidencePath: demoEvidencePath,
  evidenceCursor: demoEvidencePath.nodeIds.length,
  evidencePartial: false,
  evidenceForcedNodeIds: {},
  actTask: null,
  actAvailable: true,
  codexReason: undefined,

  onNodesChange: (changes) =>
    set((state) => ({
      nodes: applyNodeChanges(changes, state.nodes) as WorkspaceNode[],
    })),
  onEdgesChange: (changes) =>
    set((state) => ({
      edges: applyEdgeChanges(changes, state.edges) as WorkspaceEdge[],
    })),
  setConnection: (connection) => set({ connection }),

  hydrateBootstrap: (payload) => {
    const previous = get();
    const preserveSessionState = previous.remoteHydrated;
    const semanticNodes = graphRecordsToFlowNodes(payload.graph.nodes);
    const graphEdges = graphRecordsToFlowEdges(payload.graph.edges);
    const firstFile = semanticNodes.find(
      (node): node is Extract<WorkspaceNode, { type: "semantic" }> =>
        node.type === "semantic" &&
        node.data.kind === "file" &&
        Boolean(node.data.relativePath),
    );
    const panelNodes = previous.nodes
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
    const expansionCursors: Record<string, string | null> = {};
    const evidenceForcedNodeIds = preserveSessionState
      ? previous.evidenceForcedNodeIds
      : {};
    const visibleState = visibleGraphState(
      restoredNodes,
      graphEdges,
      collapsedNodeIds,
      expansionCursors,
      payload.graph.truncated,
      evidenceForcedNodeIds,
    );
    const restoredAssistant = visibleState.nodes.find(
      (node) => node.type === "assistantPanel",
    );
    const lastUser = payload.conversation?.findLast(
      (message) => message.role === "user",
    );
    const lastAssistant = payload.conversation?.findLast(
      (message) => message.role === "assistant",
    );
    set({
      workspaceName: payload.workspace.name,
      askThreadId: `${payload.workspace.id}:main`,
      rootPath: payload.workspace.rootPath,
      branch: payload.workspace.branch ?? "—",
      nodes: visibleState.nodes,
      edges: graphEdges,
      graphRevision: payload.graph.revision,
      graphSourceTruncated: payload.graph.truncated,
      graphTruncated: visibleState.graphTruncated,
      graphCursor: payload.graph.cursor,
      graphReconciling: false,
      remoteHydrated: true,
      expansionCursors,
      collapsedNodeIds,
      index: payload.index,
      connection: "connected",
      demoMode: false,
      question: preserveSessionState
        ? previous.question
        : lastUser?.content ?? "",
      answer: preserveSessionState
        ? previous.answer
        : lastAssistant?.content ?? "",
      assistantError: null,
      assistantThinking: false,
      activeAskTurnId: null,
      evidencePath: preserveSessionState
        ? previous.evidencePath
        : lastAssistant?.evidence ?? null,
      evidenceCursor: preserveSessionState
        ? previous.evidenceCursor
        : lastAssistant?.evidence?.nodeIds.length ?? 0,
      evidencePartial: preserveSessionState
        ? previous.evidencePartial
        : false,
      evidenceForcedNodeIds,
      assistantMode:
        restoredAssistant?.type === "assistantPanel"
          ? restoredAssistant.data.mode
          : "ask",
      actAvailable: payload.capabilities?.act ?? false,
      codexReason: payload.capabilities?.codexReason,
    });
    const fixedIds = new Set(
      payload.layout
        ?.filter((item) => item.kind === "index")
        .map((item) => item.id) ?? [],
    );
    void applySemanticLayout(
      new Set(
        semanticNodes
          .map((node) => node.id)
          .filter((id) => !fixedIds.has(id)),
      ),
    );
  },

  reconcileGraph: async () => {
    if (get().demoMode || !apiClient.hasToken) return;
    if (reconcilePromise) return reconcilePromise;
    set({ graphReconciling: true });
    reconcilePromise = apiClient
      .bootstrap()
      .then((payload) => {
        get().hydrateBootstrap(payload);
      })
      .catch((error: unknown) => {
        set({
          connection: "degraded",
          graphReconciling: false,
          assistantError:
            error instanceof Error
              ? error.message
              : "No se pudo reconciliar el grafo.",
        });
      })
      .finally(() => {
        reconcilePromise = null;
        set({ graphReconciling: false });
      });
    return reconcilePromise;
  },

  handleAgentEvent: (event) => {
    switch (event.type) {
      case "connection.ready":
        set({
          connection: get().remoteHydrated ? "connected" : "connecting",
          demoMode: false,
        });
        void get().reconcileGraph();
        break;
      case "index.progress":
        if ("index" in event) {
          set({ index: event.index });
        } else {
          const payload = event.payload;
          set((state) => ({
            index: {
              phase: payload.phase,
              progress:
                payload.total === 0 ? 0 : payload.completed / payload.total,
              filesIndexed: payload.completed,
              symbolsIndexed: state.nodes.filter(
                (node) => node.type === "semantic",
              ).length,
              edgesIndexed: state.edges.length,
              ...(payload.message ? { message: payload.message } : {}),
            },
          }));
        }
        break;
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
        const existingNodeIds = new Set(state.nodes.map((node) => node.id));
        const expansionCursors: Record<string, string | null> = {};
        const visibleState = visibleGraphState(
          result.nodes,
          result.edges,
          state.collapsedNodeIds,
          expansionCursors,
          state.graphSourceTruncated,
          state.evidenceForcedNodeIds,
        );
        set({
          nodes: visibleState.nodes,
          edges: result.edges,
          graphRevision: result.revision,
          graphTruncated: visibleState.graphTruncated,
          expansionCursors,
        });
        void applySemanticLayout(
          new Set(
            result.nodes
              .filter((node) => !existingNodeIds.has(node.id))
              .map((node) => node.id),
          ),
        );
        break;
      }
      case "graph.snapshot": {
        const state = get();
        if (event.graph.revision < state.graphRevision) break;
        const panels = state.nodes.filter((node) => node.type !== "semantic");
        const positions = new Map(
          state.nodes
            .filter((node) => node.type === "semantic")
            .map((node) => [node.id, node.position]),
        );
        const semanticNodes = graphRecordsToFlowNodes(event.graph.nodes).map(
          (node) => ({
            ...node,
            position: positions.get(node.id) ?? node.position,
          }),
        );
        const graphEdges = graphRecordsToFlowEdges(event.graph.edges);
        const expansionCursors: Record<string, string | null> = {};
        const visibleState = visibleGraphState(
          [...semanticNodes, ...panels] as WorkspaceNode[],
          graphEdges,
          state.collapsedNodeIds,
          expansionCursors,
          event.graph.truncated,
          state.evidenceForcedNodeIds,
        );
        set({
          nodes: visibleState.nodes,
          edges: graphEdges,
          graphRevision: event.graph.revision,
          graphSourceTruncated: event.graph.truncated,
          graphTruncated: visibleState.graphTruncated,
          graphCursor: event.graph.cursor,
          expansionCursors,
        });
        void applySemanticLayout(
          new Set(
            semanticNodes
              .map((node) => node.id)
              .filter((id) => !positions.has(id)),
          ),
        );
        break;
      }
      case "ask.delta":
        set((state) => ({
          answer: state.answer + event.delta,
          assistantThinking: true,
          assistantError: null,
        }));
        break;
      case "ask.event": {
        const askEvent = event.payload;
        if (askEvent.type === "text_delta") {
          set((state) => ({
            answer: state.answer + askEvent.delta,
            assistantThinking: true,
            assistantError: null,
          }));
        } else if (askEvent.type === "evidence") {
          get().playEvidencePath(askEvent.path);
        } else if (askEvent.type === "completed") {
          set({
            assistantThinking: false,
            activeAskTurnId: null,
            assistantError: null,
          });
        } else if (askEvent.type === "error") {
          set({
            assistantThinking: false,
            activeAskTurnId: null,
            assistantError: askEvent.message,
          });
        }
        break;
      }
      case "ask.completed":
        set((state) => ({
          answer: event.answer ?? state.answer,
          assistantThinking: false,
          activeAskTurnId: null,
          assistantError: null,
        }));
        if (event.evidencePath) get().playEvidencePath(event.evidencePath);
        break;
      case "ask.error":
        set({
          assistantThinking: false,
          activeAskTurnId: null,
          assistantError: event.message,
        });
        break;
      case "terminal.output":
        window.dispatchEvent(
          new CustomEvent("constelix:terminal-output", {
            detail: "payload" in event ? event.payload : event,
          }),
        );
        break;
      case "terminal.exit": {
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
      case "act.event":
        set((state) => {
          const payload = "payload" in event ? event.payload : event;
          const taskId =
            "taskId" in payload && typeof payload.taskId === "string"
              ? payload.taskId
              : "";
          if (!state.actTask || state.actTask.id !== taskId) return state;
          const rawStatus =
            "status" in payload && typeof payload.status === "string"
              ? payload.status
              : undefined;
          const status = rawStatus
            ? toViewTaskStatus(rawStatus as ActTaskStatus)
            : state.actTask.status;
          const message =
            "message" in payload && typeof payload.message === "string"
              ? payload.message
              : "event" in payload && typeof payload.event === "string"
                ? payload.event
                : "Evento recibido de Codex";
          return {
            actTask: {
              ...state.actTask,
              status,
              output: [...state.actTask.output, message],
            },
          };
        });
        break;
      default:
        break;
    }
  },

  selectNode: (selectedNodeId) => set({ selectedNodeId }),

  raisePanel: (id) =>
    set((state) => {
      const panel = state.nodes.find(
        (node) => node.id === id && node.type !== "semantic",
      );
      if (!panel) return state;
      return {
        nodes: state.nodes.map((node) =>
          node.id === id
            ? { ...node, zIndex: nextToolPanelZIndex(state.nodes) }
            : node,
        ) as WorkspaceNode[],
      };
    }),

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

  createTerminal: (cwd = ".", anchorNodeId) => {
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

  registerTerminalRuntime: (panelId, runtime) =>
    set((state) => ({
      terminalRuntimes: {
        ...state.terminalRuntimes,
        [panelId]: runtime,
      },
    })),

  clearTerminalRuntime: (panelId) =>
    set((state) => {
      const { [panelId]: _removed, ...terminalRuntimes } =
        state.terminalRuntimes;
      return { terminalRuntimes };
    }),

  expandNode: async (nodeId) => {
    if (get().demoMode) return;
    const cursors = get().expansionCursors;
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
      const existingIdsBeforeExpansion = new Set(
        get().nodes.map((node) => node.id),
      );
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
          state.graphSourceTruncated || snapshot.truncated,
          state.evidenceForcedNodeIds,
        );
        return {
          expansionCursors,
          collapsedNodeIds,
          nodes: visibleState.nodes,
          edges: mergedEdges,
          graphSourceTruncated:
            state.graphSourceTruncated || snapshot.truncated,
          graphTruncated: visibleState.graphTruncated,
          graphCursor: snapshot.cursor,
        };
      });
      void applySemanticLayout(
        new Set(
          snapshot.nodes
            .map((node) => node.id)
            .filter((id) => !existingIdsBeforeExpansion.has(id)),
        ),
      );
    } catch (error) {
      set({
        assistantError:
          error instanceof Error
            ? error.message
            : "No se pudo expandir el nodo.",
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
    const prompt = get().question.trim();
    if (!prompt || get().assistantThinking) return;
    const state = get();
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
      answer: "",
      assistantThinking: true,
      assistantError: null,
      evidencePath: null,
      evidenceCursor: 0,
      evidencePartial: false,
      evidenceForcedNodeIds: {},
    });

    if (get().demoMode) {
      window.setTimeout(() => {
        set({
          answer:
            "La consulta entra por `/api/query`, pasa por `query.handler.ts` y `QueryService`. Después, `GraphIndexer` consulta `ProjectGraph`, mientras `LocalAgentService` mantiene el índice actualizado.",
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
      );
      set({ activeAskTurnId: turn.turnId });
    } catch (error) {
      set({
        assistantThinking: false,
        activeAskTurnId: null,
        assistantError:
          error instanceof Error
            ? error.message
            : "No se pudo consultar al agente.",
      });
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
        evidencePartial: missingNodeIds.length > 0,
        evidenceForcedNodeIds,
      });
    } else {
      set({
        nodes: visibleState.nodes,
        graphTruncated: visibleState.graphTruncated,
        evidencePath,
        evidenceCursor: 1,
        evidencePartial: missingNodeIds.length > 0,
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

    if (missingNodeIds.length > 0 && !state.demoMode) {
      void Promise.allSettled(
        missingNodeIds.map((nodeId) => get().expandNode(nodeId)),
      ).then(() => {
        const refreshed = get();
        const refreshedIds = new Set(
          refreshed.nodes
            .filter((node) => node.type === "semantic")
            .map((node) => node.id),
        );
        const remaining = evidencePath.nodeIds.filter(
          (nodeId) => !refreshedIds.has(nodeId),
        );
        const forced = Object.fromEntries(
          evidencePath.nodeIds
            .filter((nodeId) => refreshedIds.has(nodeId))
            .map((nodeId) => [nodeId, true]),
        );
        const refreshedVisible = visibleGraphState(
          refreshed.nodes,
          refreshed.edges,
          refreshed.collapsedNodeIds,
          refreshed.expansionCursors,
          refreshed.graphSourceTruncated,
          forced,
        );
        set({
          nodes: refreshedVisible.nodes,
          graphTruncated: refreshedVisible.graphTruncated,
          evidencePartial: remaining.length > 0,
          evidenceForcedNodeIds: forced,
        });
      });
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
    if (evidence) {
      get().updateEditorPanel({
        revealLine: evidence.range.start.line + 1,
      });
    }
  },

  createActTask: async () => {
    const objective = get().question.trim();
    if (!objective) return;
    if (get().demoMode) {
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
    const task = get().actTask;
    if (!task || task.status !== "awaitingApproval") return;
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
    set({ actTask: { ...task, status: "cancelled" } });
    if (!get().demoMode) {
      await apiClient.cancelActTask(task.id).catch(() => undefined);
    }
  },

  resetActTask: () => set({ actTask: null, assistantError: null }),

  saveLayout: () => {
    if (layoutTimer !== null) window.clearTimeout(layoutTimer);
    if (get().demoMode) return;
    layoutTimer = window.setTimeout(() => {
      const state = get();
      const layout = state.nodes.flatMap<PanelState>((node) => {
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
                : state.assistantMode;
        const anchorNodeId =
          "anchorNodeId" in node.data &&
          typeof node.data.anchorNodeId === "string"
            ? node.data.anchorNodeId
            : undefined;
        const resource =
          node.type === "semantic"
            ? {
                semantic: true,
                collapsed: Boolean(state.collapsedNodeIds[node.id]),
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
                    mode: state.assistantMode,
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
          pinned: false,
          updatedAt: new Date().toISOString(),
        }];
      });
      void apiClient.saveLayout(layout).catch(() => undefined);
    }, 450);
  },
}));

async function applySemanticLayout(
  targetIds: ReadonlySet<string>,
): Promise<void> {
  if (targetIds.size === 0) return;
  const state = useWorkspaceStore.getState();
  try {
    const positions = await layoutSemanticNodes(state.nodes, state.edges);
    useWorkspaceStore.setState((current) => ({
      nodes: current.nodes.map((node) => {
        if (
          node.type !== "semantic" ||
          !targetIds.has(node.id)
        ) {
          return node;
        }
        const position = positions[node.id];
        return position ? { ...node, position } : node;
      }) as WorkspaceNode[],
    }));
  } catch {
    // The deterministic column layout remains usable if the layout worker fails.
  }
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
