import { LocateFixed, LockKeyhole, Maximize, Minus, Plus } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
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
import type { SemanticFlowNode, WorkspaceNode } from "../../types";
import { AssistantPanel } from "../panels/AssistantPanel";
import { EditorPanel } from "../panels/EditorPanel";
import { TerminalPanel } from "../panels/TerminalPanel";
import { GraphEdge } from "./GraphEdge";
import { Legend } from "./Legend";
import { SemanticNode } from "./SemanticNode";

const nodeTypes = {
  semantic: SemanticNode,
  editorPanel: EditorPanel,
  terminalPanel: TerminalPanel,
  assistantPanel: AssistantPanel
} satisfies NodeTypes;

const edgeTypes = { graphEdge: GraphEdge } satisfies EdgeTypes;

const initialZoom = Math.min(
  1,
  Math.max(0.58, Math.min((window.innerWidth - 96) / 1460, (window.innerHeight - 72) / 900))
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

function CanvasInner() {
  const nodes = useWorkspaceStore((state) => state.nodes);
  const edges = useWorkspaceStore((state) => state.edges);
  const onNodesChange = useWorkspaceStore((state) => state.onNodesChange);
  const onEdgesChange = useWorkspaceStore((state) => state.onEdgesChange);
  const selectNode = useWorkspaceStore((state) => state.selectNode);
  const openFile = useWorkspaceStore((state) => state.openFile);
  const openTerminal = useWorkspaceStore((state) => state.openTerminal);
  const expandNode = useWorkspaceStore((state) => state.expandNode);
  const saveLayout = useWorkspaceStore((state) => state.saveLayout);
  const evidencePath = useWorkspaceStore((state) => state.evidencePath);
  const evidenceCursor = useWorkspaceStore((state) => state.evidenceCursor);
  const index = useWorkspaceStore((state) => state.index);
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const [locked, setLocked] = useState(false);

  const decoratedNodes = useMemo(() => {
    if (!evidencePath) return nodes;
    const positionById = new Map(evidencePath.nodeIds.map((nodeId, index) => [nodeId, index]));
    return nodes.map((node) => {
      if (node.type !== "semantic") return node;
      const evidenceIndex = positionById.get(node.id);
      if (evidenceIndex === undefined || evidenceIndex >= evidenceCursor) {
        if (!node.data.evidenceState) return node;
        const { evidenceState: _evidenceState, ...data } = node.data;
        return { ...node, data } as WorkspaceNode;
      }
      return {
        ...node,
        data: { ...node.data, evidenceState: evidenceIndex === evidenceCursor - 1 ? "current" : "visited" }
      } as WorkspaceNode;
    });
  }, [evidenceCursor, evidencePath, nodes]);

  const decoratedEdges = useMemo(() => {
    if (!evidencePath) return edges;
    const positionById = new Map(evidencePath.edgeIds.map((edgeId, index) => [edgeId, index]));
    return edges.map((edge) => {
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
  }, [edges, evidenceCursor, evidencePath]);

  useEffect(() => {
    const focusGraph = () => {
      const semanticNodes = nodes.filter((node) => node.type === "semantic").map(({ id }) => ({ id }));
      if (semanticNodes.length) void fitView({ nodes: semanticNodes, padding: 0.16, duration: 320, maxZoom: 1 });
    };
    window.addEventListener("constelix:fit-graph", focusGraph);
    return () => window.removeEventListener("constelix:fit-graph", focusGraph);
  }, [fitView, nodes]);

  return (
    <main className="workspace-canvas" aria-label="Mapa visual del proyecto" data-testid="workspace-canvas">
      <ReactFlow
        nodes={decoratedNodes}
        edges={decoratedEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => selectNode(node.id)}
        onNodeDoubleClick={(_, node) => {
          if (node.type !== "semantic") return;
          const semanticNode = node as SemanticFlowNode;
          const path = semanticNode.data.relativePath;
          if (!path) return;
          if (semanticNode.data.kind === "directory" || semanticNode.data.kind === "workspace") {
            void expandNode(node.id);
          } else {
            void expandNode(node.id);
            openFile(path, node.id);
          }
        }}
        onNodeContextMenu={(event, node) => {
          if (node.type !== "semantic") return;
          const semanticNode = node as SemanticFlowNode;
          if (semanticNode.data.kind !== "directory" && semanticNode.data.kind !== "workspace") return;
          event.preventDefault();
          openTerminal(semanticNode.data.relativePath ?? ".", node.id);
        }}
        onPaneClick={() => selectNode(null)}
        onNodeDragStop={saveLayout}
        defaultViewport={initialViewport}
        minZoom={0.35}
        maxZoom={1.7}
        panOnScroll
        zoomOnScroll
        zoomOnPinch
        nodesConnectable={false}
        nodesDraggable={!locked}
        elevateNodesOnSelect
        onlyRenderVisibleElements
        colorMode="dark"
        proOptions={{ hideAttribution: false }}
        fitViewOptions={{ padding: 0.12 }}
      >
        <Background variant={BackgroundVariant.Dots} color="#2a3538" gap={18} size={0.85} />
        <MiniMap
          ariaLabel="Minimapa del proyecto"
          className="constelix-minimap"
          position="bottom-right"
          nodeColor={miniMapColor}
          nodeStrokeWidth={1.5}
          maskColor="rgba(8, 13, 14, 0.72)"
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
      {index.phase !== "ready" ? (
        <div className={`index-status index-status--${index.phase}`} role="status">
          <span className="index-status-dot" />
          <span>{index.message ?? "Indexando…"}</span>
          <strong>{Math.round(index.progress * 100)}%</strong>
        </div>
      ) : null}
    </main>
  );
}

export const WorkspaceCanvas = memo(function WorkspaceCanvas() {
  return <ReactFlowProvider><CanvasInner /></ReactFlowProvider>;
});
