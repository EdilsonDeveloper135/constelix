import { MarkerType } from "@xyflow/react";

import type {
  AssistantFlowNode,
  EditorFlowNode,
  IndexStatus,
  GraphRelation,
  Confidence,
  SemanticFlowNode,
  TerminalFlowNode,
  WorkspaceEdge,
  WorkspaceNode
} from "../types";

export const DEMO_SOURCE = `import { ProjectGraph, GraphNode, GraphEdge } from "@/types/graph";
import { walk } from "@/utils/walk";
import { hashContent } from "@/utils/hash";

export async function GraphIndexer(rootPath: string): Promise<ProjectGraph> {
  // 1. Recorre el árbol de archivos
  const files = await walk(rootPath, options.include);

  // 2. Construir nodos
  const nodes: GraphNode[] = [];
  for (const file of files) {
    const content = await readTextFile(file.path);
    const hash = hashContent(content);
    nodes.push({
      id: file.path,
      type: file.type,
      label: file.name,
      hash,
      metadata: file.metadata,
    });
  }

  // 3. Detectar dependencias e importaciones
  const edges: GraphEdge[] = [];
  for (const node of nodes) {
    const imports = await detectImports(node);
    for (const dependency of imports) {
      edges.push({ source: node.id, target: dependency.id, type: "imports" });
    }
  }

  return { nodes, edges };
}`;

const semantic = (
  id: string,
  x: number,
  y: number,
  kind: SemanticFlowNode["data"]["kind"],
  label: string,
  detail?: string,
  relativePath?: string
): SemanticFlowNode => ({
  id,
  type: "semantic",
  position: { x, y },
  data: {
    kind,
    label,
    ...(detail ? { detail } : {}),
    ...(relativePath ? { relativePath } : {})
  },
  draggable: true
});

const editorPanel: EditorFlowNode = {
  id: "panel-editor",
  type: "editorPanel",
  position: { x: 900, y: 30 },
  style: { width: 560, height: 620 },
  dragHandle: ".panel-titlebar",
  data: {
    panelType: "editor",
    title: "Editor — GraphIndexer.ts",
    relativePath: "apps/local-agent/src/indexers/GraphIndexer.ts",
    language: "typescript",
    preview: DEMO_SOURCE,
    contentHash: "demo"
  },
  zIndex: 20
};

const terminalPanel: TerminalFlowNode = {
  id: "panel-terminal",
  type: "terminalPanel",
  position: { x: 0, y: 570 },
  style: { width: 410, height: 310 },
  dragHandle: ".panel-titlebar",
  data: {
    panelType: "terminal",
    title: "Terminal — apps/local-agent",
    cwd: "apps/local-agent"
  },
  zIndex: 18
};

const assistantPanel: AssistantFlowNode = {
  id: "panel-assistant",
  type: "assistantPanel",
  position: { x: 455, y: 675 },
  style: { width: 625, height: 210 },
  dragHandle: ".panel-titlebar",
  data: { panelType: "assistant", title: "IA — Consulta", mode: "ask" },
  zIndex: 19
};

export const demoSemanticNodes: SemanticFlowNode[] = [
  semantic("dir-web", 500, 35, "directory", "apps/web"),
  semantic("dir-src", 355, 125, "directory", "src"),
  semantic("dir-routes", 490, 125, "directory", "routes"),
  semantic("dir-components", 640, 125, "directory", "components"),
  semantic("dir-lib", 795, 125, "directory", "lib"),
  semantic("route-query", 480, 215, "route", "/api/query", "POST", "apps/web/src/routes/query.ts"),
  semantic("file-handler", 440, 300, "file", "query.handler.ts", "TypeScript", "apps/web/src/routes/query.handler.ts"),
  semantic("class-canvas", 785, 245, "class", "WorkspaceCanvas", "class", "apps/web/src/components/WorkspaceCanvas.tsx"),
  semantic("module-query", 720, 375, "module", "QueryService", "export", "apps/local-agent/src/services/query.ts"),
  semantic("fn-indexer", 565, 475, "function", "GraphIndexer", "async function", "apps/local-agent/src/indexers/GraphIndexer.ts"),
  semantic("class-project", 815, 455, "class", "ProjectGraph", "class", "packages/graph-core/src/project.ts"),
  semantic("file-indexer", 560, 555, "file", "graph-indexer.ts", "TypeScript", "apps/local-agent/src/indexers/GraphIndexer.ts"),
  semantic("class-node", 700, 625, "class", "GraphNode", "class", "packages/contracts/src/graph.ts"),
  semantic("class-edge", 835, 625, "class", "GraphEdge", "class", "packages/contracts/src/graph.ts"),
  semantic("class-store", 970, 625, "class", "GraphStore", "class", "packages/graph-core/src/store.ts"),
  semantic("dir-agent", 75, 220, "directory", "apps/local-agent"),
  semantic("file-agent-index", 95, 325, "file", "index.ts", "TypeScript", "apps/local-agent/src/index.ts"),
  {
    ...semantic("service-agent", 195, 425, "service", "LocalAgentService", "servicio", "apps/local-agent/src/service.ts"),
    data: { kind: "service", label: "LocalAgentService", detail: "servicio", relativePath: "apps/local-agent/src/service.ts", health: "healthy" }
  },
  semantic("module-terminal", 220, 530, "module", "terminal.gateway", "módulo", "apps/local-agent/src/terminal/gateway.ts")
];

export const demoNodes: WorkspaceNode[] = [...demoSemanticNodes, editorPanel, terminalPanel, assistantPanel];

const edge = (
  id: string,
  source: string,
  target: string,
  relation: GraphRelation,
  confidence: Confidence = "extracted"
): WorkspaceEdge => ({
  id,
  source,
  target,
  type: "graphEdge",
  markerEnd: { type: MarkerType.ArrowClosed, width: 13, height: 13 },
  data: { relation, confidence }
});

export const demoEdges: WorkspaceEdge[] = [
  edge("e-web-src", "dir-web", "dir-src", "contains"),
  edge("e-web-routes", "dir-web", "dir-routes", "contains"),
  edge("e-web-components", "dir-web", "dir-components", "contains"),
  edge("e-web-lib", "dir-web", "dir-lib", "contains"),
  edge("e-routes-query", "dir-routes", "route-query", "contains"),
  edge("e-query-handler", "route-query", "file-handler", "calls"),
  edge("e-handler-query-service", "file-handler", "module-query", "imports"),
  edge("e-components-canvas", "dir-components", "class-canvas", "contains"),
  edge("e-canvas-query", "class-canvas", "module-query", "imports"),
  edge("e-query-indexer", "module-query", "fn-indexer", "calls"),
  edge("e-query-project", "module-query", "class-project", "exports"),
  edge("e-indexer-project", "fn-indexer", "class-project", "imports"),
  edge("e-indexer-file", "fn-indexer", "file-indexer", "contains"),
  edge("e-project-node", "class-project", "class-node", "contains"),
  edge("e-project-edge", "class-project", "class-edge", "contains"),
  edge("e-project-store", "class-project", "class-store", "contains"),
  edge("e-agent-index", "dir-agent", "file-agent-index", "contains"),
  edge("e-index-service", "file-agent-index", "service-agent", "calls"),
  edge("e-service-terminal", "service-agent", "module-terminal", "contains"),
  edge("e-service-indexer", "service-agent", "fn-indexer", "calls"),
  edge("e-indexer-service", "fn-indexer", "service-agent", "calls", "resolved")
];

export const demoEvidencePath = {
  protocolVersion: 1 as const,
  nodeIds: ["route-query", "file-handler", "module-query", "fn-indexer", "class-project"],
  edgeIds: ["e-query-handler", "e-handler-query-service", "e-query-indexer", "e-indexer-project"],
  evidence: [],
  complete: true
};

export const demoIndexStatus: IndexStatus = {
  phase: "ready",
  progress: 1,
  filesIndexed: 1842,
  symbolsIndexed: 3912,
  edgesIndexed: 8731,
  message: "Índice actualizado"
};

export const demoTerminalLines = [
  "\u001b[36mconstelix@MacBook-Pro\u001b[0m ~/Proyectos/constelix/apps/local-agent \u001b[33m(main)\u001b[0m",
  "$ pnpm run index:watch",
  "",
  "> local-agent@1.0.0 index:watch",
  "> tsx src/index.ts --watch",
  "",
  "\u001b[32m[12:41:02] Local Agent iniciado en modo watch\u001b[0m",
  "\u001b[32m[12:41:02] Conectado a terminal.gateway\u001b[0m",
  "\u001b[32m[12:41:03] Indexando proyecto en ../../..\u001b[0m",
  "\u001b[32m[12:41:03] Archivos encontrados: 1,842\u001b[0m",
  "\u001b[32m[12:41:07] Nodos generados: 3,912\u001b[0m",
  "\u001b[32m[12:41:07] Aristas generadas: 8,731\u001b[0m",
  "\u001b[32m[12:41:07] Índice actualizado correctamente ✓\u001b[0m"
];
