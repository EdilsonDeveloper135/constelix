import type { Edge, Node } from "@xyflow/react";
import type {
  EvidencePath as ContractEvidencePath,
  GraphSnapshot as ContractGraphSnapshot,
  PanelState,
  ServerEvent
} from "@constelix/contracts";

export const PROTOCOL_VERSION = 1 as const;

export type SemanticNodeKind =
  | "workspace"
  | "directory"
  | "file"
  | "module"
  | "class"
  | "interface"
  | "function"
  | "method"
  | "route"
  | "service"
  | "external";

export type GraphRelation =
  | "contains"
  | "imports"
  | "exports"
  | "extends"
  | "implements"
  | "calls";

export type Confidence = "extracted" | "resolved" | "ambiguous";

export interface SemanticNodeData extends Record<string, unknown> {
  kind: SemanticNodeKind;
  label: string;
  detail?: string;
  relativePath?: string;
  language?: string;
  count?: number;
  childCount?: number;
  expanded?: boolean;
  collapsed?: boolean;
  hasMore?: boolean;
  collapsedHidden?: boolean;
  capacityHidden?: boolean;
  health?: "healthy" | "warning" | "idle";
  evidenceState?: "visited" | "current";
}

export interface EditorPanelData extends Record<string, unknown> {
  panelType: "editor";
  title: string;
  relativePath: string;
  language: string;
  preview: string;
  contentHash?: string;
  anchorNodeId?: string;
  revealLine?: number;
  collapsed?: boolean;
  expandedHeight?: number;
}

export interface TerminalPanelData extends Record<string, unknown> {
  panelType: "terminal";
  title: string;
  cwd: string;
  terminalId?: string;
  anchorNodeId?: string;
  collapsed?: boolean;
  expandedHeight?: number;
}

export type AssistantMode = "ask" | "act";

export interface AssistantPanelData extends Record<string, unknown> {
  panelType: "assistant";
  title: string;
  mode: AssistantMode;
  collapsed?: boolean;
  expandedHeight?: number;
}

export type SemanticFlowNode = Node<SemanticNodeData, "semantic">;
export type EditorFlowNode = Node<EditorPanelData, "editorPanel">;
export type TerminalFlowNode = Node<TerminalPanelData, "terminalPanel">;
export type AssistantFlowNode = Node<AssistantPanelData, "assistantPanel">;
export type WorkspaceNode =
  | SemanticFlowNode
  | EditorFlowNode
  | TerminalFlowNode
  | AssistantFlowNode;

export interface WorkspaceEdgeData extends Record<string, unknown> {
  relation: GraphRelation;
  confidence: Confidence;
  evidenceActive?: boolean;
  evidenceVisited?: boolean;
}

export type WorkspaceEdge = Edge<WorkspaceEdgeData, "graphEdge">;

export type EvidencePath = ContractEvidencePath;
export type GraphSnapshot = ContractGraphSnapshot;

export interface IndexStatus {
  phase: "idle" | "scanning" | "parsing" | "resolving" | "persisting" | "ready" | "error";
  progress: number;
  filesIndexed: number;
  symbolsIndexed: number;
  edgesIndexed: number;
  message?: string;
}

export interface BootstrapPayload {
  protocolVersion: 1;
  workspace: {
    id: string;
    name: string;
    rootPath: string;
    branch?: string;
  };
  graph: GraphSnapshot;
  index: IndexStatus;
  layout?: PanelState[];
  conversation?: Array<{ role: "user" | "assistant"; content: string; evidence?: EvidencePath }>;
  capabilities?: {
    ask: boolean;
    act: boolean;
    terminal: boolean;
    codexReason?: string;
  };
}

export interface TerminalRuntime {
  terminalId: string;
  cwd: string;
  status: "running" | "exited";
  exitLabel?: string;
}

export interface ActTask {
  id: string;
  objective: string;
  status: "draft" | "awaitingApproval" | "running" | "completed" | "cancelled" | "failed";
  expiresAt: string;
  output: string[];
}

export type ConnectionState = "connecting" | "connected" | "degraded";
export type RailTool = "map" | "files" | "diagrams" | "editor" | "terminal" | "preview" | "ai";

type LegacyAgentEvent =
  | { protocolVersion: 1; type: "connection.ready" }
  | { protocolVersion: 1; type: "index.progress"; index: IndexStatus }
  | { protocolVersion: 1; type: "graph.snapshot"; graph: GraphSnapshot }
  | { protocolVersion: 1; type: "ask.delta"; threadId: string; delta: string }
  | { protocolVersion: 1; type: "ask.completed"; threadId: string; answer?: string; evidencePath?: EvidencePath }
  | { protocolVersion: 1; type: "ask.error"; threadId: string; message: string }
  | { protocolVersion: 1; type: "terminal.output"; terminalId: string; data: string; sequence?: number }
  | { protocolVersion: 1; type: "act.event"; taskId: string; message: string; status?: ActTask["status"] };

export type AgentEvent = ServerEvent | LegacyAgentEvent;
