import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const ProtocolVersionSchema = z.literal(PROTOCOL_VERSION);

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

export const GraphConfidenceSchema = z.enum(["extracted", "resolved", "ambiguous"]);

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

export const PanelStateSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  id: z.string().min(1),
  kind: PanelKindSchema,
  position: z.object({ x: z.number(), y: z.number() }),
  size: z.object({ width: z.number().positive(), height: z.number().positive() }),
  resource: z.record(z.string(), z.unknown()).default({}),
  anchorNodeId: z.string().optional(),
  zoom: z.number().positive().default(1),
  pinned: z.boolean().default(false),
  updatedAt: z.string().datetime()
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
  AskStreamBaseSchema.extend({ type: z.literal("started") }),
  AskStreamBaseSchema.extend({ type: z.literal("text_delta"), delta: z.string() }),
  AskStreamBaseSchema.extend({
    type: z.literal("tool_call"),
    tool: AskToolNameSchema,
    callId: z.string().min(1),
    arguments: z.record(z.string(), z.unknown())
  }),
  AskStreamBaseSchema.extend({ type: z.literal("evidence"), path: EvidencePathSchema }),
  AskStreamBaseSchema.extend({ type: z.literal("completed"), responseId: z.string().optional() }),
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
  shell: z.string().optional()
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
  ServerEventBaseSchema.extend({ type: z.literal("graph.delta"), payload: GraphDeltaSchema }),
  ServerEventBaseSchema.extend({
    type: z.literal("index.progress"),
    payload: z.object({
      phase: z.enum(["scanning", "parsing", "resolving", "persisting", "ready", "error"]),
      completed: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      message: z.string().optional()
    })
  }),
  ServerEventBaseSchema.extend({
    type: z.literal("terminal.output"),
    payload: z.object({
      terminalId: z.string().min(1),
      data: z.string(),
      sequence: z.number().int().positive().optional()
    })
  }),
  ServerEventBaseSchema.extend({
    type: z.literal("terminal.exit"),
    payload: z.object({ terminalId: z.string().min(1), exitCode: z.number().int().nullable(), signal: z.number().int().nullable() })
  }),
  ServerEventBaseSchema.extend({ type: z.literal("ask.event"), payload: AskStreamEventSchema }),
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
    payload: z.object({ code: z.string(), message: z.string(), recoverable: z.boolean() })
  })
]);

export type SourcePosition = z.infer<typeof SourcePositionSchema>;
export type SourceRange = z.infer<typeof SourceRangeSchema>;
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
export type PanelState = z.infer<typeof PanelStateSchema>;
export type FileReadRequest = z.infer<typeof FileReadRequestSchema>;
export type FileReadResponse = z.infer<typeof FileReadResponseSchema>;
export type FileWriteRequest = z.infer<typeof FileWriteRequestSchema>;
export type FileWriteResponse = z.infer<typeof FileWriteResponseSchema>;
export type EvidencePath = z.infer<typeof EvidencePathSchema>;
export type AskToolName = z.infer<typeof AskToolNameSchema>;
export type AskTurnRequest = z.infer<typeof AskTurnRequestSchema>;
export type AskStreamEvent = z.infer<typeof AskStreamEventSchema>;
export type ActCapability = z.infer<typeof ActCapabilitySchema>;
export type ActTaskScope = z.infer<typeof ActTaskScopeSchema>;
export type ActTaskStatus = z.infer<typeof ActTaskStatusSchema>;
export type ActTask = z.infer<typeof ActTaskSchema>;
export type ActTaskRequest = z.infer<typeof ActTaskRequestSchema>;
export type ActApproveRequest = z.infer<typeof ActApproveRequestSchema>;
export type TerminalCreateRequest = z.infer<typeof TerminalCreateRequestSchema>;
export type TerminalOutputChunk = z.infer<typeof TerminalOutputChunkSchema>;
export type TerminalOutputSnapshot = z.infer<typeof TerminalOutputSnapshotSchema>;
export type ServerEvent = z.infer<typeof ServerEventSchema>;
