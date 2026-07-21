import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const ProtocolVersionSchema = z.literal(PROTOCOL_VERSION);
export const WorkspaceIdSchema = z.string().regex(/^[a-f0-9]{24}$/);
export const WorkspaceAccessModeSchema = z.enum(["read", "edit"]);

export const SourcePositionSchema = z.object({
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative()
});

export const SourceRangeSchema = z.object({
  start: SourcePositionSchema,
  end: SourcePositionSchema,
  startByte: z.number().int().nonnegative().optional(),
  endByte: z.number().int().nonnegative().optional()
});

export const LanguageSchema = z.enum([
  "javascript",
  "jsx",
  "typescript",
  "tsx",
  "python",
  "unknown"
]);

export const WorkspaceWarningSchema = z.object({
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(1_000),
  relativePath: z.string().min(1).optional()
});

export const WorkspaceOmittedFileSchema = z.object({
  relativePath: z.string().min(1),
  reason: z.enum([
    "ignored",
    "secret",
    "unsupported",
    "too_large",
    "binary",
    "outside_workspace",
    "file_limit",
    "source_budget"
  ])
});

export const WorkspaceSummarySchema = z.object({
  projectTypes: z.array(z.string().min(1).max(100)).max(20).default([]),
  languages: z.array(LanguageSchema).max(20).default([]),
  estimatedFileCount: z.number().int().nonnegative(),
  indexedFileCount: z.number().int().nonnegative(),
  warnings: z.array(WorkspaceWarningSchema).max(200).default([]),
  omittedFiles: z.array(WorkspaceOmittedFileSchema).max(200).default([]),
  omittedFileCount: z.number().int().nonnegative(),
  omittedFilesTruncated: z.boolean().default(false)
});

export const GraphNodeKindSchema = z.enum([
  "project",
  "folder",
  "file",
  "module",
  "class",
  "interface",
  "function",
  "method",
  "external"
]);

export const GraphRelationSchema = z.enum([
  "contains",
  "imports",
  "exports",
  "extends",
  "implements",
  "calls"
]);

export const GraphConfidenceSchema = z.enum(["extracted", "inferred", "ambiguous"]);

export const GraphEvidenceSchema = z.object({
  relativePath: z.string().min(1),
  range: SourceRangeSchema,
  excerpt: z.string().max(500).optional()
});

export const GraphNodeSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  id: z.string().min(1),
  kind: GraphNodeKindSchema,
  name: z.string(),
  qualifiedName: z.string(),
  relativePath: z.string(),
  range: SourceRangeSchema.optional(),
  language: LanguageSchema,
  revision: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const GraphEdgeSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  relation: GraphRelationSchema,
  confidence: GraphConfidenceSchema,
  evidence: z.array(GraphEvidenceSchema).default([]),
  revision: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const GraphSnapshotSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  workspaceId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  truncated: z.boolean().default(false),
  cursor: z.string().optional()
});

export const GraphDeltaSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  workspaceId: z.string().min(1),
  previousRevision: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  nodesAdded: z.array(GraphNodeSchema).default([]),
  nodesUpdated: z.array(GraphNodeSchema).default([]),
  nodeIdsRemoved: z.array(z.string()).default([]),
  edgesAdded: z.array(GraphEdgeSchema).default([]),
  edgesUpdated: z.array(GraphEdgeSchema).default([]),
  edgeIdsRemoved: z.array(z.string()).default([])
});

export const GraphDirectionSchema = z.enum(["inbound", "outbound", "both"]);

export const GraphQuerySchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  rootIds: z.array(z.string()).default([]),
  direction: GraphDirectionSchema.default("outbound"),
  relations: z.array(GraphRelationSchema).default([]),
  nodeKinds: z.array(GraphNodeKindSchema).default([]),
  depth: z.number().int().min(0).max(12).default(2),
  search: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(500).default(200),
  cursor: z.string().optional()
});

export const PanelKindSchema = z.enum(["editor", "terminal", "ask", "act", "inspector", "index"]);
export const PanelDockSchema = z.enum(["floating", "right", "bottom"]);

export const PanelStateSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  id: z.string().min(1),
  kind: PanelKindSchema,
  position: z.object({ x: z.number(), y: z.number() }),
  size: z.object({ width: z.number().positive(), height: z.number().positive() }),
  resource: z.record(z.string(), z.unknown()).default({}),
  anchorNodeId: z.string().optional(),
  dock: PanelDockSchema.default("floating"),
  dockActive: z.boolean().default(false),
  zoom: z.number().positive().default(1),
  pinned: z.boolean().default(false),
  updatedAt: z.string().datetime()
});

export const LayoutWriteRequestSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  revision: z.number().int().nonnegative().optional(),
  panels: z.array(PanelStateSchema).max(600)
});

export const ProtocolOnlyRequestSchema = z.object({
  protocolVersion: ProtocolVersionSchema
});

export const FileReadRequestSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  relativePath: z.string().min(1)
});

export const FileReadResponseSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  relativePath: z.string().min(1),
  content: z.string(),
  contentHash: z.string().min(1),
  language: LanguageSchema,
  size: z.number().int().nonnegative(),
  modifiedAt: z.string().datetime()
});

export const FileWriteRequestSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  relativePath: z.string().min(1),
  content: z.string(),
  expectedContentHash: z.string().min(1)
});

export const FileWriteResponseSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  relativePath: z.string().min(1),
  contentHash: z.string().min(1),
  modifiedAt: z.string().datetime(),
  graphRevision: z.number().int().nonnegative().optional()
});

export const EvidencePathSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  nodeIds: z.array(z.string().min(1)).min(1),
  edgeIds: z.array(z.string().min(1)),
  evidence: z.array(GraphEvidenceSchema).default([]),
  complete: z.boolean().default(true)
}).superRefine((value, context) => {
  if (value.complete && value.edgeIds.length !== Math.max(0, value.nodeIds.length - 1)) {
    context.addIssue({
      code: "custom",
      message: "A complete evidence path must contain exactly one edge between consecutive nodes",
      path: ["edgeIds"]
    });
  }
});

export const AskToolNameSchema = z.enum([
  "search_graph",
  "get_node",
  "get_neighbors",
  "shortest_path",
  "read_snippet"
]);

export const AskModeSchema = z.enum(["local", "openai"]);
export const AskProviderStatusSchema = z.enum([
  "ready",
  "missing_api_key",
  "insufficient_quota",
  "invalid_api_key",
  "network_unavailable",
  "rate_limited",
  "unavailable"
]);

export const LlmProviderKindSchema = z.enum(["openai", "ollama", "compatible"]);
export const LlmApiKeySourceSchema = z.enum(["none", "environment", "stored"]);

export const LlmPublicConfigurationSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  baseUrl: z.string().min(1).max(2_048),
  model: z.string().min(1).max(256),
  providerKind: LlmProviderKindSchema,
  apiKeyConfigured: z.boolean(),
  apiKeyRequired: z.boolean(),
  apiKeySource: LlmApiKeySourceSchema
}).strict();

export const LlmApiKeyUpdateSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preserve") }).strict(),
  z.object({
    action: z.literal("replace"),
    value: z.string().min(1).max(8_192)
  }).strict(),
  z.object({ action: z.literal("clear") }).strict()
]);

export const LlmConfigurationUpdateSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  baseUrl: z.string().trim().min(1).max(2_048),
  model: z.string().trim().min(1).max(256),
  apiKey: LlmApiKeyUpdateSchema
}).strict();

export const LocalAskRelationSchema = z.object({
  edgeId: z.string().min(1),
  relation: GraphRelationSchema,
  direction: z.enum(["inbound", "outbound"]),
  targetNodeId: z.string().min(1),
  confidence: GraphConfidenceSchema
});

export const LocalAskSnippetSchema = z.object({
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  content: z.string().max(2_000)
});

export const LocalAskHitSchema = z.object({
  nodeId: z.string().min(1),
  kind: GraphNodeKindSchema,
  name: z.string(),
  qualifiedName: z.string(),
  relativePath: z.string(),
  range: SourceRangeSchema.optional(),
  language: LanguageSchema,
  signature: z.string().max(500).optional(),
  score: z.number().nonnegative(),
  matchedFields: z.array(
    z.enum(["name", "qualifiedName", "path", "signature"])
  ).max(4),
  relations: z.array(LocalAskRelationSchema).max(24).default([]),
  snippet: LocalAskSnippetSchema.optional()
});

export const LocalAskResultSchema = z.object({
  query: z.string(),
  revision: z.number().int().nonnegative(),
  hits: z.array(LocalAskHitSchema).max(20),
  truncated: z.boolean(),
  limitations: z.array(z.string().max(500)).max(10).default([])
});

export const AskTurnRequestSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  requestId: z.string().min(1),
  threadId: z.string().min(1),
  prompt: z.string().trim().min(1).max(20_000),
  selectedNodeIds: z.array(z.string()).max(50).default([])
});

const AskStreamBaseSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  requestId: z.string().min(1),
  threadId: z.string().min(1)
});

export const AskStreamEventSchema = z.discriminatedUnion("type", [
  AskStreamBaseSchema.extend({
    type: z.literal("started"),
    mode: AskModeSchema
  }),
  AskStreamBaseSchema.extend({ type: z.literal("text_delta"), delta: z.string() }),
  AskStreamBaseSchema.extend({
    type: z.literal("tool_call"),
    tool: AskToolNameSchema,
    callId: z.string().min(1),
    arguments: z.record(z.string(), z.unknown())
  }),
  AskStreamBaseSchema.extend({ type: z.literal("evidence"), path: EvidencePathSchema }),
  AskStreamBaseSchema.extend({
    type: z.literal("fallback"),
    from: z.literal("openai"),
    to: z.literal("local"),
    code: z.string().min(1),
    message: z.string().min(1),
    discardPartial: z.boolean()
  }),
  AskStreamBaseSchema.extend({
    type: z.literal("completed"),
    mode: AskModeSchema,
    responseId: z.string().optional(),
    answer: z.string(),
    evidence: EvidencePathSchema.optional(),
    localResult: LocalAskResultSchema.optional()
  }),
  AskStreamBaseSchema.extend({ type: z.literal("error"), code: z.string(), message: z.string() })
]);

export const ActCapabilitySchema = z.enum(["read", "write", "command"]);

export const ActTaskScopeSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  workspaceId: z.string().min(1),
  rootPath: z.string().min(1),
  objective: z.string().trim().min(1).max(20_000),
  capabilities: z.array(ActCapabilitySchema).min(1),
  networkEnabled: z.boolean(),
  outsideWorkspaceWrites: z.literal(false),
  expiresAt: z.string().datetime()
});

export const ActTaskStatusSchema = z.enum([
  "pending_approval",
  "approved",
  "running",
  "completed",
  "cancelled",
  "expired",
  "failed"
]);

export const ActTaskSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  id: z.string().min(1),
  scope: ActTaskScopeSchema,
  status: ActTaskStatusSchema,
  createdAt: z.string().datetime(),
  approvedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  error: z.string().optional()
});

export const ActTaskRequestSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  objective: z.string().trim().min(1).max(20_000),
  capabilities: z.array(ActCapabilitySchema).min(1).default(["read", "write", "command"])
});

export const ActApproveRequestSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  taskId: z.string().min(1),
  approved: z.literal(true)
});

export const TerminalCreateRequestSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  cwd: z.string().default("."),
  columns: z.number().int().min(2).max(1_000).default(120),
  rows: z.number().int().min(1).max(500).default(32),
  shell: z.string().optional(),
  panelId: z.string().min(1).max(200).optional()
});

export const TerminalSessionSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  id: z.string().min(1),
  panelId: z.string().min(1).max(200).optional(),
  cwd: z.string().min(1),
  shell: z.string().min(1),
  createdAt: z.string().datetime(),
  status: z.enum(["running", "exited"])
});

export const TerminalOutputChunkSchema = z.object({
  sequence: z.number().int().positive(),
  data: z.string()
});

export const TerminalOutputSnapshotSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  terminalId: z.string().min(1),
  chunks: z.array(TerminalOutputChunkSchema),
  latestSequence: z.number().int().nonnegative(),
  truncated: z.boolean()
});

const ServerEventBaseSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  eventId: z.string().min(1),
  timestamp: z.string().datetime()
});

export const ServerEventSchema = z.discriminatedUnion("type", [
  ServerEventBaseSchema.extend({
    type: z.literal("connection.ready"),
    payload: z.object({}).strict()
  }),
  ServerEventBaseSchema.extend({ type: z.literal("graph.delta"), payload: GraphDeltaSchema }),
  ServerEventBaseSchema.extend({
    type: z.literal("graph.snapshot"),
    payload: z.object({
      graph: GraphSnapshotSchema,
      provisional: z.boolean()
    })
  }),
  ServerEventBaseSchema.extend({
    type: z.literal("index.progress"),
    payload: z.object({
      phase: z.enum(["scanning", "parsing", "resolving", "persisting", "ready", "error"]),
      completed: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      revision: z.number().int().nonnegative(),
      progress: z.number().min(0).max(1),
      filesIndexed: z.number().int().nonnegative(),
      symbolsIndexed: z.number().int().nonnegative(),
      edgesIndexed: z.number().int().nonnegative(),
      message: z.string().optional(),
      summary: WorkspaceSummarySchema.optional()
    })
  }),
  ServerEventBaseSchema.extend({
    type: z.literal("terminal.output"),
    payload: z.object({
      terminalId: z.string().min(1),
      data: z.string(),
      sequence: z.number().int().positive()
    })
  }),
  ServerEventBaseSchema.extend({
    type: z.literal("terminal.exit"),
    payload: z.object({ terminalId: z.string().min(1), exitCode: z.number().int().nullable(), signal: z.number().int().nullable() })
  }),
  ServerEventBaseSchema.extend({ type: z.literal("ask.event"), payload: AskStreamEventSchema }),
  ServerEventBaseSchema.extend({
    type: z.literal("capabilities.updated"),
    payload: z.object({
      act: z.boolean().optional(),
      checking: z.boolean().optional(),
      askMode: AskModeSchema.optional(),
      askProviderStatus: AskProviderStatusSchema.optional(),
      askNotice: z.string().nullable().optional(),
      llm: LlmPublicConfigurationSchema.optional(),
      codexVersion: z.string().optional(),
      codexReason: z.string().optional()
    })
  }),
  ServerEventBaseSchema.extend({
    type: z.literal("act.event"),
    payload: z.object({
      taskId: z.string().min(1),
      event: z.string(),
      message: z.string().optional(),
      status: z.enum(["draft", "awaitingApproval", "running", "completed", "cancelled", "failed"]).optional(),
      data: z.unknown().optional()
    })
  }),
  ServerEventBaseSchema.extend({
    type: z.literal("error"),
    payload: z.object({
      code: z.string(),
      message: z.string(),
      recoverable: z.boolean(),
      severity: z.enum(["info", "warning", "error"]).default("error")
    })
  })
]);

export const ClientEventSchema = z.discriminatedUnion("type", [
  z.object({
    protocolVersion: ProtocolVersionSchema,
    type: z.literal("terminal.input"),
    terminalId: z.string().min(1),
    data: z.string().max(256 * 1024)
  }).strict(),
  z.object({
    protocolVersion: ProtocolVersionSchema,
    type: z.literal("terminal.resize"),
    terminalId: z.string().min(1),
    cols: z.number().int().min(2).max(1_000),
    rows: z.number().int().min(1).max(500)
  }).strict(),
  z.object({
    protocolVersion: ProtocolVersionSchema,
    type: z.literal("ask.cancel"),
    turnId: z.string().min(1)
  }).strict()
]);

export type SourcePosition = z.infer<typeof SourcePositionSchema>;
export type SourceRange = z.infer<typeof SourceRangeSchema>;
export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;
export type WorkspaceAccessMode = z.infer<typeof WorkspaceAccessModeSchema>;
export type WorkspaceWarning = z.infer<typeof WorkspaceWarningSchema>;
export type WorkspaceOmittedFile = z.infer<typeof WorkspaceOmittedFileSchema>;
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;
export type Language = z.infer<typeof LanguageSchema>;
export type GraphNodeKind = z.infer<typeof GraphNodeKindSchema>;
export type GraphRelation = z.infer<typeof GraphRelationSchema>;
export type GraphConfidence = z.infer<typeof GraphConfidenceSchema>;
export type GraphEvidence = z.infer<typeof GraphEvidenceSchema>;
export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;
export type GraphSnapshot = z.infer<typeof GraphSnapshotSchema>;
export type GraphDelta = z.infer<typeof GraphDeltaSchema>;
export type GraphDirection = z.infer<typeof GraphDirectionSchema>;
export type GraphQuery = z.infer<typeof GraphQuerySchema>;
export type PanelKind = z.infer<typeof PanelKindSchema>;
export type PanelDock = z.infer<typeof PanelDockSchema>;
export type PanelState = z.infer<typeof PanelStateSchema>;
export type LayoutWriteRequest = z.infer<typeof LayoutWriteRequestSchema>;
export type ProtocolOnlyRequest = z.infer<typeof ProtocolOnlyRequestSchema>;
export type FileReadRequest = z.infer<typeof FileReadRequestSchema>;
export type FileReadResponse = z.infer<typeof FileReadResponseSchema>;
export type FileWriteRequest = z.infer<typeof FileWriteRequestSchema>;
export type FileWriteResponse = z.infer<typeof FileWriteResponseSchema>;
export type EvidencePath = z.infer<typeof EvidencePathSchema>;
export type AskToolName = z.infer<typeof AskToolNameSchema>;
export type AskMode = z.infer<typeof AskModeSchema>;
export type AskProviderStatus = z.infer<typeof AskProviderStatusSchema>;
export type LlmProviderKind = z.infer<typeof LlmProviderKindSchema>;
export type LlmApiKeySource = z.infer<typeof LlmApiKeySourceSchema>;
export type LlmPublicConfiguration = z.infer<typeof LlmPublicConfigurationSchema>;
export type LlmApiKeyUpdate = z.infer<typeof LlmApiKeyUpdateSchema>;
export type LlmConfigurationUpdate = z.infer<typeof LlmConfigurationUpdateSchema>;
export type LocalAskRelation = z.infer<typeof LocalAskRelationSchema>;
export type LocalAskSnippet = z.infer<typeof LocalAskSnippetSchema>;
export type LocalAskHit = z.infer<typeof LocalAskHitSchema>;
export type LocalAskResult = z.infer<typeof LocalAskResultSchema>;
export type AskTurnRequest = z.infer<typeof AskTurnRequestSchema>;
export type AskStreamEvent = z.infer<typeof AskStreamEventSchema>;
export type ActCapability = z.infer<typeof ActCapabilitySchema>;
export type ActTaskScope = z.infer<typeof ActTaskScopeSchema>;
export type ActTaskStatus = z.infer<typeof ActTaskStatusSchema>;
export type ActTask = z.infer<typeof ActTaskSchema>;
export type ActTaskRequest = z.infer<typeof ActTaskRequestSchema>;
export type ActApproveRequest = z.infer<typeof ActApproveRequestSchema>;
export type TerminalCreateRequest = z.infer<typeof TerminalCreateRequestSchema>;
export type TerminalSession = z.infer<typeof TerminalSessionSchema>;
export type TerminalOutputChunk = z.infer<typeof TerminalOutputChunkSchema>;
export type TerminalOutputSnapshot = z.infer<typeof TerminalOutputSnapshotSchema>;
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ClientEvent = z.infer<typeof ClientEventSchema>;

const CLEAR_SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----|$)/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{35}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\bsk_live_[A-Za-z0-9]{20,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
] as const;

const SECRET_ASSIGNMENT_PATTERN =
  /((?:(?:aws[_-]?)?secret[_-]?access[_-]?key|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|token|secret|password|passwd)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi;

/** Redacts high-confidence credential material before graph data leaves the analyzer boundary. */
export function redactSensitiveText(value: string): string {
  let redacted = value;
  for (const pattern of CLEAR_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED_CREDENTIAL]");
  }
  return redacted.replace(SECRET_ASSIGNMENT_PATTERN, "$1[REDACTED]");
}

export function sanitizeGraphNode(node: GraphNode): GraphNode {
  return {
    ...node,
    metadata: sanitizeRecord(node.metadata),
  };
}

export function sanitizeGraphEdge(edge: GraphEdge): GraphEdge {
  return {
    ...edge,
    evidence: edge.evidence.map((item) => ({
      ...item,
      ...(item.excerpt === undefined ? {} : { excerpt: redactSensitiveText(item.excerpt) }),
    })),
    metadata: sanitizeRecord(edge.metadata),
  };
}

export function sanitizeGraphSnapshot(snapshot: GraphSnapshot): GraphSnapshot {
  return GraphSnapshotSchema.parse({
    ...snapshot,
    nodes: snapshot.nodes.map(sanitizeGraphNode),
    edges: snapshot.edges.map(sanitizeGraphEdge),
  });
}

export function sanitizeGraphDelta(delta: GraphDelta): GraphDelta {
  return GraphDeltaSchema.parse({
    ...delta,
    nodesAdded: delta.nodesAdded.map(sanitizeGraphNode),
    nodesUpdated: delta.nodesUpdated.map(sanitizeGraphNode),
    edgesAdded: delta.edgesAdded.map(sanitizeGraphEdge),
    edgesUpdated: delta.edgesUpdated.map(sanitizeGraphEdge),
  });
}

export function sanitizeUnknownStrings(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(sanitizeUnknownStrings);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeUnknownStrings(item)]),
  );
}

function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeUnknownStrings(value) as Record<string, unknown>;
}
