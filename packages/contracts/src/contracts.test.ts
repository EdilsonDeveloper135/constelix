import { describe, expect, it } from "vitest";
import {
  ActTaskScopeSchema,
  AskStreamEventSchema,
  LocalAskResultSchema,
  ClientEventSchema,
  EvidencePathSchema,
  GraphConfidenceSchema,
  GraphNodeSchema,
  GraphQuerySchema,
  LlmConfigurationUpdateSchema,
  LlmPublicConfigurationSchema,
  PanelStateSchema,
  PROTOCOL_VERSION,
  ServerEventSchema,
  WorkspaceIdSchema,
  WorkspaceSummarySchema,
} from "./index.js";

describe("protocol contracts", () => {
  it("applies safe graph query defaults", () => {
    const query = GraphQuerySchema.parse({ protocolVersion: PROTOCOL_VERSION });

    expect(query).toMatchObject({
      rootIds: [],
      direction: "outbound",
      relations: [],
      nodeKinds: [],
      depth: 2,
      limit: 200
    });
  });

  it("rejects unsupported protocol versions", () => {
    expect(() => GraphNodeSchema.parse({ protocolVersion: 2 })).toThrow();
  });

  it("uses the approved graph confidence vocabulary", () => {
    expect(GraphConfidenceSchema.parse("inferred")).toBe("inferred");
    expect(() => GraphConfidenceSchema.parse("resolved")).toThrow();
  });

  it("defaults panels to floating while accepting explicit docks", () => {
    const panel = PanelStateSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      id: "editor-1",
      kind: "editor",
      position: { x: 10, y: 20 },
      size: { width: 600, height: 400 },
      resource: {},
      updatedAt: "2026-07-18T00:00:00.000Z",
    });

    expect(panel.dock).toBe("floating");
    expect(PanelStateSchema.parse({ ...panel, dock: "bottom" }).dock).toBe("bottom");
    expect(() => PanelStateSchema.parse({ ...panel, dock: "left" })).toThrow();
  });

  it("separates public LLM settings from write-only secret updates", () => {
    const publicConfiguration = LlmPublicConfigurationSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen2.5-coder:7b",
      providerKind: "ollama",
      apiKeyConfigured: false,
      apiKeyRequired: false,
      apiKeySource: "none",
    });
    expect(Object.hasOwn(publicConfiguration, "apiKey")).toBe(false);
    expect(() => LlmPublicConfigurationSchema.parse({
      ...publicConfiguration,
      apiKey: "must-not-cross-the-response-boundary",
    })).toThrow();

    expect(LlmConfigurationUpdateSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      apiKey: { action: "replace", value: "write-only-key" },
    }).apiKey).toEqual({ action: "replace", value: "write-only-key" });
  });

  it("strictly validates post-handshake client WebSocket messages", () => {
    expect(() => ClientEventSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      type: "authenticate",
      token: "obsolete-capability-message",
    })).toThrow();
    expect(() => ClientEventSchema.parse({
      protocolVersion: 2,
      type: "ask.cancel",
      turnId: "turn",
    })).toThrow();
    expect(() => ClientEventSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      type: "terminal.resize",
      terminalId: "terminal",
      cols: 80,
      rows: 24,
      unexpected: true,
    })).toThrow();
  });

  it("keeps terminal Ask and index events self-contained for reconnection", () => {
    expect(AskStreamEventSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "request",
      threadId: "thread",
      type: "completed",
      mode: "openai",
      responseId: "response",
      answer: "The verified answer.",
    })).toMatchObject({
      type: "completed",
      answer: "The verified answer.",
    });
    expect(() => AskStreamEventSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "request",
      threadId: "thread",
      type: "completed",
      mode: "openai",
      responseId: "response",
    })).toThrow();

    expect(ServerEventSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      eventId: "event",
      timestamp: "2026-07-16T00:00:00.000Z",
      type: "index.progress",
      payload: {
        phase: "ready",
        completed: 12,
        total: 12,
        revision: 4,
        progress: 1,
        filesIndexed: 12,
        symbolsIndexed: 48,
        edgesIndexed: 31,
      },
    }).payload).toMatchObject({
      revision: 4,
      filesIndexed: 12,
      symbolsIndexed: 48,
      edgesIndexed: 31,
    });

    expect(ServerEventSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      eventId: "capabilities",
      timestamp: "2026-07-16T00:00:00.000Z",
      type: "capabilities.updated",
      payload: {
        act: true,
        checking: false,
        codexVersion: "0.144.5",
      },
    }).payload).toEqual({
      act: true,
      checking: false,
      codexVersion: "0.144.5",
    });
  });

  it("validates stable workspace identities and bounded onboarding summaries", () => {
    expect(WorkspaceIdSchema.parse("0123456789abcdef01234567")).toHaveLength(24);
    expect(() => WorkspaceIdSchema.parse("workspace")).toThrow();
    expect(WorkspaceSummarySchema.parse({
      projectTypes: ["pnpm", "typescript"],
      languages: ["typescript", "python"],
      estimatedFileCount: 32,
      indexedFileCount: 12,
      warnings: [],
      omittedFiles: [],
      omittedFileCount: 0,
    })).toMatchObject({
      estimatedFileCount: 32,
      omittedFilesTruncated: false,
    });
  });

  it("represents local Ask results without claiming generated reasoning", () => {
    expect(LocalAskResultSchema.parse({
      query: "WorkspaceIndexer",
      revision: 4,
      hits: [{
        nodeId: "node",
        kind: "class",
        name: "WorkspaceIndexer",
        qualifiedName: "src/indexer.WorkspaceIndexer",
        relativePath: "src/indexer.ts",
        language: "typescript",
        score: 10,
        matchedFields: ["name", "qualifiedName"],
        relations: [],
      }],
      truncated: false,
      limitations: ["Búsqueda estructural local; no es una respuesta generada."],
    }).hits[0]?.name).toBe("WorkspaceIndexer");
  });

  it("requires a complete path to join consecutive nodes", () => {
    expect(() => EvidencePathSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      nodeIds: ["a", "b", "c"],
      edgeIds: ["one"],
      complete: true
    })).toThrow(/one edge/i);
  });

  it("makes writes outside the workspace impossible in an act scope", () => {
    expect(() => ActTaskScopeSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      workspaceId: "workspace",
      rootPath: "/tmp/workspace",
      objective: "Refactor the parser",
      capabilities: ["read", "write"],
      networkEnabled: true,
      outsideWorkspaceWrites: true,
      expiresAt: new Date().toISOString()
    })).toThrow();
  });
});
