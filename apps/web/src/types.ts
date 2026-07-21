import type { Edge, Node } from "@xyflow/react";
import type {
  ActTask as ContractActTask,
  AskMode,
  AskProviderStatus,
  EvidencePath as ContractEvidencePath,
  GraphSnapshot as ContractGraphSnapshot,
  LocalAskResult,
  PanelDock as ContractPanelDock,
  PanelState,
  ServerEvent,
  SourceRange,
  TerminalSession,
  WorkspaceAccessMode,
  WorkspaceSummary,
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

export type Confidence = "extracted" | "inferred" | "ambiguous";

export interface SemanticNodeData extends Record<string, unknown> {
  kind: SemanticNodeKind;
  label: string;
  detail?: string;
  relativePath?: string;
  range?: SourceRange;
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

export type WorkspaceMode = WorkspaceAccessMode;
export type WorkspaceAskMode = AskMode;
export type WorkspaceAskProviderStatus = AskProviderStatus;
export type PanelDock = ContractPanelDock;

export interface EditorPanelData extends Record<string, unknown> {
  panelType: "editor";
  dock: PanelDock;
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
  dock: PanelDock;
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
  dock: PanelDock;
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
export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  evidence?: EvidencePath;
  mode?: WorkspaceAskMode;
  localResult?: LocalAskResult;
}

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
    mode: WorkspaceMode;
    readOnly: boolean;
    branch?: string;
  };
  summary: WorkspaceSummary;
  graph: GraphSnapshot;
  index: IndexStatus;
  layout?: PanelState[];
  conversation?: ConversationMessage[];
  activeAskTurnIds: string[];
  activeActTask: ContractActTask | null;
  terminals: TerminalSession[];
  capabilities?: {
    ask: boolean;
    askMode: WorkspaceAskMode;
    askProviderStatus: WorkspaceAskProviderStatus;
    askNotice?: string;
    act: boolean;
    terminal: boolean;
    codexReason?: string;
    codexChecking?: boolean;
    codexVersion?: string;
  };
}

export interface WorkspaceNotice {
  id: string;
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  recoverable: boolean;
}

export interface CanvasFilters {
  nodeKind: SemanticNodeKind | "all";
  extension: string | "all";
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
  status:
    | "draft"
    | "awaitingApproval"
    | "running"
    | "cancelling"
    | "completed"
    | "cancelled"
    | "failed";
  expiresAt: string;
  output: string[];
}

export type ConnectionState = "connecting" | "connected" | "degraded";
export type RailTool = "map" | "files" | "diagrams" | "editor" | "terminal" | "preview" | "ai";

export type AgentEvent = ServerEvent;
