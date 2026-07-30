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
  LspAvailabilitySchema,
  LspLanguageSchema,
  LlmConfigurationUpdateSchema,
  LlmPublicConfigurationSchema,
  PanelStateSchema,
  PROTOCOL_VERSION,
  RecentWorkspaceSchema,
  ServerEventSchema,
  WorkspaceBrowseResponseSchema,
  WorkspaceIdSchema,
  WorkspaceListResponseSchema,
  WorkspaceLockConflictSchema,
  WorkspaceOpenRequestSchema,
  WorkspaceOpenResponseSchema,
  WorkspaceSessionSchema,
  WorkspaceSummarySchema,
  WorkspaceTargetSchema,
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

  it("keeps workspace sessions strict, stable, and safe to publish", () => {
    const session = WorkspaceSessionSchema.parse({
      id: "161c08c7-ad9b-47df-94b7-86db634a1f4f",
      workspaceId: "0123456789abcdef01234567",
      activatedAt: "2026-07-25T20:30:00.000Z",
    });

    expect(session.workspaceId).toBe("0123456789abcdef01234567");
    expect(() => WorkspaceSessionSchema.parse({
      ...session,
      canonicalRoot: "/Users/developer/private-project",
    })).toThrow();
    expect(() => WorkspaceSessionSchema.parse({
      ...session,
      id: "not-a-uuid",
    })).toThrow();
  });

  it("bounds public workspace recents and never accepts canonical roots", () => {
    const session = {
      id: "161c08c7-ad9b-47df-94b7-86db634a1f4f",
      workspaceId: "0123456789abcdef01234567",
      activatedAt: "2026-07-25T20:30:00.000Z",
    };
    const recent = {
      protocolVersion: PROTOCOL_VERSION,
      workspaceId: "abcdef0123456789abcdef01",
      name: "Proyecto Ω",
      displayPath: "~/Projects/Proyecto Ω",
      lastOpenedAt: "2026-07-25T20:31:00.000Z",
      availability: "available" as const,
      lastMode: "edit" as const,
    };

    expect(RecentWorkspaceSchema.parse(recent)).toEqual(recent);
    expect(() => RecentWorkspaceSchema.parse({
      ...recent,
      canonicalRoot: "/Users/developer/Projects/Proyecto Ω",
    })).toThrow();
    expect(WorkspaceListResponseSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      activeSession: session,
      recents: Array.from({ length: 12 }, (_, index) => ({
        ...recent,
        workspaceId: index.toString(16).padStart(24, "0"),
      })),
    }).recents).toHaveLength(12);
    expect(() => WorkspaceListResponseSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      activeSession: session,
      recents: Array.from({ length: 13 }, (_, index) => ({
        ...recent,
        workspaceId: index.toString(16).padStart(24, "0"),
      })),
    })).toThrow();
  });

  it("validates absolute workspace targets and session-bound open requests", () => {
    const target = WorkspaceTargetSchema.parse({
      kind: "path",
      path: "/Users/developer/Projects/Proyecto con espacios",
    });
    const request = WorkspaceOpenRequestSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "17384852-376d-4a5d-9476-59d1070f0f8b",
      expectedSessionId: "161c08c7-ad9b-47df-94b7-86db634a1f4f",
      target,
      lockResolution: {
        action: "force-release",
        expectedLockId: "6422c1c1-5188-461f-98c0-e1a9560ecdb3",
        acknowledgeRisk: true,
      },
    });

    expect(request.target).toEqual(target);
    expect(() => WorkspaceTargetSchema.parse({
      kind: "path",
      path: "relative/project",
    })).toThrow();
    expect(() => WorkspaceTargetSchema.parse({
      kind: "path",
      path: "/tmp/project\0escape",
    })).toThrow();
    expect(() => WorkspaceOpenRequestSchema.parse({
      ...request,
      expectedSessionId: "stale-session",
    })).toThrow();
    expect(WorkspaceOpenResponseSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      session: {
        id: "3c4fb9db-4cb4-44b5-91d4-6eb0a97d9ea7",
        workspaceId: "abcdef0123456789abcdef01",
        activatedAt: "2026-07-25T20:32:00.000Z",
      },
      bootstrap: {},
    }).session.workspaceId).toBe("abcdef0123456789abcdef01");
  });

  it("validates safe directory-only browse pages and their cursor bounds", () => {
    const page = WorkspaceBrowseResponseSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      path: "/Users/developer/Projects",
      parentPath: "/Users/developer",
      entries: [{
        name: "Proyecto Ω",
        path: "/Users/developer/Projects/Proyecto Ω",
        symlink: false,
      }, {
        name: "linked-project",
        path: "/Users/developer/Projects/linked-project",
        symlink: true,
      }],
      cursor: "opaque-signed-cursor",
      truncated: true,
    });

    expect(page.entries.map((entry) => entry.symlink)).toEqual([false, true]);
    expect(() => WorkspaceBrowseResponseSchema.parse({
      ...page,
      entries: [{
        name: "escape",
        path: "../outside",
        symlink: false,
      }],
    })).toThrow();
    expect(() => WorkspaceBrowseResponseSchema.parse({
      ...page,
      entries: Array.from({ length: 201 }, (_, index) => ({
        name: `directory-${index}`,
        path: `/tmp/directory-${index}`,
        symlink: false,
      })),
    })).toThrow();
    expect(() => WorkspaceBrowseResponseSchema.parse({
      ...page,
      cursor: "",
    })).toThrow();
    expect(() => WorkspaceBrowseResponseSchema.parse({
      ...page,
      cursor: undefined,
      truncated: true,
    })).toThrow();
    expect(() => WorkspaceBrowseResponseSchema.parse({
      ...page,
      truncated: false,
    })).toThrow();
  });

  it("constrains LSP availability to supported languages and strict statuses", () => {
    const availability = LspAvailabilitySchema.parse({
      javascript: { available: true },
      typescript: { available: true },
      python: {
        available: false,
        reason: "No se encontró pyright en PATH.",
      },
    });

    expect(availability.python.available).toBe(false);
    expect(LspLanguageSchema.options).toEqual([
      "javascript",
      "typescript",
      "python",
    ]);
    expect(() => LspLanguageSchema.parse("go")).toThrow();
    expect(() => LspAvailabilitySchema.parse({
      ...availability,
      go: { available: true },
    })).toThrow();
    expect(() => LspAvailabilitySchema.parse({
      ...availability,
      python: {
        available: false,
        reason: "",
      },
    })).toThrow();
  });

  it("represents workspace lock ambiguity without exposing private paths", () => {
    const conflict = WorkspaceLockConflictSchema.parse({
      conflictId: "85a8118f-a9db-40e9-a32e-9a68b5800bbb",
      lockId: "6422c1c1-5188-461f-98c0-e1a9560ecdb3",
      workspaceId: "abcdef0123456789abcdef01",
      displayPath: "~/Projects/locked-project",
      status: "ambiguous",
      forceAllowed: true,
      pid: 4812,
      agentVersion: "v0.0.5",
      heartbeatAt: "2026-07-25T20:31:30.000Z",
    });

    expect(conflict).toMatchObject({
      status: "ambiguous",
      forceAllowed: true,
    });
    expect(() => WorkspaceLockConflictSchema.parse({
      ...conflict,
      canonicalRoot: "/Users/developer/Projects/locked-project",
    })).toThrow();
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
