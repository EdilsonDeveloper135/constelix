import { LocateFixed, LockKeyhole, Maximize, Minus, Plus } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type NodeTypes,
  type EdgeTypes
} from "@xyflow/react";

import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import { useResolvedTheme } from "../../hooks/useAppearance";
import { MAX_VISIBLE_SEMANTIC_NODES } from "../../lib/workspaceGraph";
import { applyCanvasFilters } from "../../lib/canvasFilters";
import { isFloatingCanvasNode } from "../../lib/panelDock";
import { semanticNodeCwd } from "../../lib/semanticNodeActions";
import type { SemanticFlowNode, WorkspaceNode } from "../../types";
import { AssistantPanel } from "../panels/AssistantPanel";
import { DockedPanelHost } from "../panels/DockedPanelHost";
import { EditorPanel } from "../panels/EditorPanel";
import { TerminalPanel } from "../panels/TerminalPanel";
import { GraphEdge } from "./GraphEdge";
import { CanvasFilters } from "./CanvasFilters";
import { Legend } from "./Legend";
import { SemanticNode } from "./SemanticNode";
import { SemanticNodeContextMenu } from "./SemanticNodeContextMenu";
import { SemanticInspector } from "./SemanticInspector";

const nodeTypes = {
  semantic: SemanticNode,
  editorPanel: EditorPanel,
  terminalPanel: TerminalPanel,
  assistantPanel: AssistantPanel
} satisfies NodeTypes;

const edgeTypes = { graphEdge: GraphEdge } satisfies EdgeTypes;

const compactViewport = window.innerWidth <= 760;
const initialZoom = Math.min(
  1,
  Math.max(
    compactViewport ? 0.22 : 0.48,
    Math.min(
      (window.innerWidth - (compactViewport ? 12 : 96)) / 1460,
      (window.innerHeight - 72) / 900,
    ),
  ),
);

const initialViewport = { x: initialZoom === 1 ? 21 : 12, y: 0, zoom: initialZoom };

const miniMapColor = (node: Node): string => {
  if (node.type?.includes("Panel")) return "#344246";
  const kind = (node.data as { kind?: string }).kind;
  if (kind === "function") return "#d4ac43";
  if (kind === "service") return "#75c967";
  if (kind === "route") return "#43c7e2";
  if (kind === "class" || kind === "module") return "#a67adb";
  return "#788286";
};

interface ContextMenuState {
  nodeId: string;
  x: number;
  y: number;
  returnFocusTo: HTMLElement | null;
}

function CanvasInner() {
  const resolvedTheme = useResolvedTheme();
  const nodes = useWorkspaceStore((state) => state.nodes);
  const workspaceId = useWorkspaceStore((state) => state.workspaceId);
  const edges = useWorkspaceStore((state) => state.edges);
  const onNodesChange = useWorkspaceStore((state) => state.onNodesChange);
  const onEdgesChange = useWorkspaceStore((state) => state.onEdgesChange);
  const selectNode = useWorkspaceStore((state) => state.selectNode);
  const raisePanel = useWorkspaceStore((state) => state.raisePanel);
  const openFile = useWorkspaceStore((state) => state.openFile);
  const openTerminal = useWorkspaceStore((state) => state.openTerminal);
  const activateSemanticNode = useWorkspaceStore((state) => state.activateSemanticNode);
  const setCanvasZoom = useWorkspaceStore((state) => state.setCanvasZoom);
  const saveLayout = useWorkspaceStore((state) => state.saveLayout);
  const evidencePath = useWorkspaceStore((state) => state.evidencePath);
  const evidenceCursor = useWorkspaceStore((state) => state.evidenceCursor);
  const canvasFilters = useWorkspaceStore((state) => state.canvasFilters);
  const index = useWorkspaceStore((state) => state.index);
  const graphRevision = useWorkspaceStore((state) => state.graphRevision);
  const graphTruncated = useWorkspaceStore((state) => state.graphTruncated);
  const graphCursor = useWorkspaceStore((state) => state.graphCursor);
  const graphReconciling = useWorkspaceStore((state) => state.graphReconciling);
  const loadNextGraphPage = useWorkspaceStore((state) => state.loadNextGraphPage);
  const selectedNodeId = useWorkspaceStore((state) => state.selectedNodeId);
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const [locked, setLocked] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const compactFittedWorkspaceRef = useRef<string | null>(null);
  const canvasNodes = useMemo(
    () => nodes.filter(isFloatingCanvasNode),
    [nodes],
  );
  const semanticNodeCount = useMemo(
    () => nodes.filter((node) => node.type === "semantic").length,
    [nodes],
  );
  const visibleSemanticNodeCount = useMemo(
    () => nodes.filter((node) => node.type === "semantic" && !node.hidden).length,
    [nodes],
  );
  const filteredGraph = useMemo(
    () =>
      applyCanvasFilters(
        canvasNodes,
        edges,
        canvasFilters,
        new Set(evidencePath?.nodeIds ?? []),
      ),
    [canvasFilters, canvasNodes, edges, evidencePath],
  );

  const contextMenuNode = useMemo(() => {
    if (!contextMenu) return undefined;
    const node = nodes.find((candidate) => candidate.id === contextMenu.nodeId);
    return node?.type === "semantic" ? node : undefined;
  }, [contextMenu, nodes]);

  const decoratedNodes = useMemo(() => {
    const positionById = new Map(
      (evidencePath?.nodeIds ?? []).map((nodeId, index) => [nodeId, index]),
    );
    return filteredGraph.nodes.map((node) => {
      if (node.type !== "semantic") return node;
      const selected = node.id === selectedNodeId;
      const evidenceIndex = positionById.get(node.id);
      if (evidenceIndex === undefined || evidenceIndex >= evidenceCursor) {
        if (!node.data.evidenceState && node.selected === selected) return node;
        const { evidenceState: _evidenceState, ...data } = node.data;
        return { ...node, selected, data } as WorkspaceNode;
      }
      return {
        ...node,
        selected,
        data: { ...node.data, evidenceState: evidenceIndex === evidenceCursor - 1 ? "current" : "visited" }
      } as WorkspaceNode;
    });
  }, [evidenceCursor, evidencePath, filteredGraph.nodes, selectedNodeId]);

  const decoratedEdges = useMemo(() => {
    if (!evidencePath) return filteredGraph.edges;
    const positionById = new Map(evidencePath.edgeIds.map((edgeId, index) => [edgeId, index]));
    return filteredGraph.edges.map((edge) => {
      const evidenceIndex = positionById.get(edge.id);
      if (evidenceIndex === undefined) return edge;
      return {
        ...edge,
        data: {
          ...edge.data!,
          evidenceActive: evidenceIndex === evidenceCursor - 2,
          evidenceVisited: evidenceIndex < evidenceCursor - 2
        }
      };
    });
  }, [evidenceCursor, evidencePath, filteredGraph.edges]);

  useEffect(() => {
    setCanvasZoom(initialZoom);
  }, [setCanvasZoom]);

  useEffect(() => {
    if (!compactViewport || compactFittedWorkspaceRef.current === workspaceId) {
      return;
    }
    const semanticNodes = decoratedNodes
      .filter((node) => node.type === "semantic" && !node.hidden)
      .map(({ id }) => ({ id }));
    if (!workspaceId || semanticNodes.length === 0) return;
    compactFittedWorkspaceRef.current = workspaceId;
    const frame = window.requestAnimationFrame(() => {
      void fitView({
        nodes: semanticNodes,
        padding: 0.12,
        duration: 0,
        maxZoom: 0.45,
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [decoratedNodes, fitView, workspaceId]);

  useEffect(() => {
    const focusGraph = () => {
      const semanticNodes = decoratedNodes
        .filter((node) => node.type === "semantic" && !node.hidden)
        .map(({ id }) => ({ id }));
      if (semanticNodes.length) void fitView({ nodes: semanticNodes, padding: 0.16, duration: 320, maxZoom: 1 });
    };
    window.addEventListener("constelix:fit-graph", focusGraph);
    return () => window.removeEventListener("constelix:fit-graph", focusGraph);
  }, [decoratedNodes, fitView]);

  useEffect(() => {
    const focusEvidence = (event: Event) => {
      const nodeIds = (event as CustomEvent<string[]>).detail;
      const visibleIds = nodeIds.filter((nodeId) =>
        decoratedNodes.some((node) => node.id === nodeId && !node.hidden),
      );
      if (visibleIds.length === 0) return;
      void fitView({
        nodes: visibleIds.map((id) => ({ id })),
        padding: 0.22,
        duration: 220,
        maxZoom: 1,
      });
    };
    window.addEventListener("constelix:focus-evidence", focusEvidence);
    return () =>
      window.removeEventListener("constelix:focus-evidence", focusEvidence);
  }, [decoratedNodes, fitView]);

  useEffect(() => {
    if (
      !evidencePath ||
      evidenceCursor <= 0 ||
      evidenceCursor >= evidencePath.nodeIds.length
    ) {
      return;
    }
    const activeId = evidencePath?.nodeIds[evidenceCursor - 1];
    if (!activeId) return;
    const activeNode = decoratedNodes.find(
      (node) => node.id === activeId && !node.hidden,
    );
    if (!activeNode) return;
    void fitView({
      nodes: [{ id: activeId }],
      padding: 0.42,
      duration: 260,
      maxZoom: 1,
    });
  }, [decoratedNodes, evidenceCursor, evidencePath, fitView]);

  useEffect(() => {
    const openFromKeyboard = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) {
        return;
      }
      const focused = document.activeElement;
      if (!(focused instanceof HTMLElement)) return;
      const wrapper = focused.closest<HTMLElement>(".react-flow__node[data-id]");
      const nodeId = wrapper?.dataset.id;
      const node = nodes.find(
        (candidate): candidate is SemanticFlowNode =>
          candidate.id === nodeId && candidate.type === "semantic",
      );
      if (!node || !wrapper) return;
      event.preventDefault();
      const bounds = wrapper.getBoundingClientRect();
      setContextMenu({
        nodeId: node.id,
        x: bounds.left + Math.min(bounds.width, 42),
        y: bounds.top + Math.min(bounds.height, 42),
        returnFocusTo: focused,
      });
    };
    window.addEventListener("keydown", openFromKeyboard);
    return () => window.removeEventListener("keydown", openFromKeyboard);
  }, [nodes]);

  return (
    <>
      <main className="workspace-canvas" aria-label="Mapa visual del proyecto" data-testid="workspace-canvas">
      <ReactFlow
        nodes={decoratedNodes}
        edges={decoratedEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => {
          setContextMenu(null);
          if (node.type === "semantic") {
            selectNode(node.id);
          } else {
            selectNode(null);
            raisePanel(node.id);
          }
        }}
        onNodeContextMenu={(event, node) => {
          if (node.type !== "semantic") return;
          event.preventDefault();
          const target = event.target;
          const returnFocusTo =
            target instanceof HTMLElement
              ? target.closest<HTMLElement>(".react-flow__node")
              : null;
          setContextMenu({
            nodeId: node.id,
            x: event.clientX,
            y: event.clientY,
            returnFocusTo,
          });
        }}
        onPaneClick={() => {
          setContextMenu(null);
          selectNode(null);
        }}
        onNodeDragStop={saveLayout}
        onMove={(_, viewport) => setCanvasZoom(viewport.zoom)}
        defaultViewport={initialViewport}
        minZoom={0.18}
        maxZoom={1.7}
        panOnScroll
        zoomOnScroll
        zoomOnPinch
        nodesConnectable={false}
        nodesDraggable={!locked}
        elevateNodesOnSelect={false}
        onlyRenderVisibleElements
        colorMode={resolvedTheme}
        proOptions={{ hideAttribution: true }}
        fitViewOptions={{ padding: 0.12 }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          color={resolvedTheme === "light" ? "#a9bbc0" : "#2a3538"}
          gap={18}
          size={0.85}
        />
        <MiniMap
          ariaLabel="Minimapa del proyecto"
          className="constelix-minimap"
          position="bottom-right"
          nodeColor={miniMapColor}
          nodeStrokeWidth={1.5}
          maskColor={resolvedTheme === "light" ? "rgba(230, 238, 240, 0.7)" : "rgba(8, 13, 14, 0.72)"}
          pannable
          zoomable
        />
        <Controls className="constelix-controls" position="bottom-right" showZoom={false} showFitView={false} showInteractive={false}>
          <ControlButton title="Acercar" aria-label="Acercar" onClick={() => void zoomIn({ duration: 140 })}><Plus aria-hidden="true" size={15} /></ControlButton>
          <ControlButton title="Restablecer zoom" aria-label="Restablecer zoom" onClick={() => void fitView({ padding: 0.12, duration: 280 })}><LocateFixed aria-hidden="true" size={14} /></ControlButton>
          <ControlButton title="Alejar" aria-label="Alejar" onClick={() => void zoomOut({ duration: 140 })}><Minus aria-hidden="true" size={15} /></ControlButton>
          <ControlButton title="Encuadrar" aria-label="Encuadrar" onClick={() => void fitView({ padding: 0.12, duration: 280 })}><Maximize aria-hidden="true" size={14} /></ControlButton>
          <ControlButton title={locked ? "Desbloquear nodos" : "Bloquear nodos"} aria-label={locked ? "Desbloquear nodos" : "Bloquear nodos"} onClick={() => setLocked((value) => !value)}><LockKeyhole aria-hidden="true" size={13} /></ControlButton>
        </Controls>
      </ReactFlow>
      <Legend />
      <CanvasFilters evidenceOverrides={filteredGraph.evidenceOverrides} />
      {index.phase !== "ready" || graphReconciling ? (
        <div className={`index-status index-status--${index.phase}`} role="status">
          <span className="index-status-dot" />
          <span>{graphReconciling ? "Reconciliando grafo…" : index.message ?? "Indexando…"}</span>
          <strong>{Math.round(index.progress * 100)}%</strong>
        </div>
      ) : (
        <div className="index-status index-status--ready" role="status">
          <span className="index-status-dot" />
          <span>{index.filesIndexed.toLocaleString()} archivos · {index.symbolsIndexed.toLocaleString()} símbolos · {index.edgesIndexed.toLocaleString()} relaciones</span>
          <strong>rev {graphRevision}</strong>
        </div>
      )}
      {graphTruncated ? (
        <div className="graph-partial-status" role="status">
          <span>
            Vista parcial: {visibleSemanticNodeCount.toLocaleString()} de {semanticNodeCount.toLocaleString()} nodos cargados
            {semanticNodeCount > MAX_VISIBLE_SEMANTIC_NODES ? ` · límite visual ${MAX_VISIBLE_SEMANTIC_NODES}` : ""}
          </span>
          {graphCursor ? (
            <button
              type="button"
              disabled={graphReconciling}
              onClick={() => void loadNextGraphPage()}
            >
              {graphReconciling ? "Cargando…" : "Siguiente lote"}
            </button>
          ) : null}
        </div>
      ) : null}
      </main>
      {contextMenu && contextMenuNode ? (
        <SemanticNodeContextMenu
          node={contextMenuNode}
          x={contextMenu.x}
          y={contextMenu.y}
          returnFocusTo={contextMenu.returnFocusTo}
          onClose={() => setContextMenu(null)}
          onInspect={() => selectNode(contextMenuNode.id)}
          onActivate={() => void activateSemanticNode(contextMenuNode.id)}
          onOpenFile={() => {
            if (contextMenuNode.data.relativePath) {
              openFile(contextMenuNode.data.relativePath, contextMenuNode.id);
            }
          }}
          onOpenTerminal={() =>
            openTerminal(semanticNodeCwd(contextMenuNode.data), contextMenuNode.id)
          }
        />
      ) : null}
    </>
  );
}

export const WorkspaceCanvas = memo(function WorkspaceCanvas() {
  return (
    <ReactFlowProvider>
      <div className="workspace-stage">
        <CanvasInner />
        <SemanticInspector />
        <DockedPanelHost />
      </div>
    </ReactFlowProvider>
  );
});
