import { describe, expect, it } from "vitest";
import {
  ActTaskScopeSchema,
  AskStreamEventSchema,
  ClientEventSchema,
  EvidencePathSchema,
  GraphConfidenceSchema,
  GraphNodeSchema,
  GraphQuerySchema,
  PROTOCOL_VERSION,
  ServerEventSchema,
  WebSocketAuthenticationSchema,
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

  it("strictly validates authentication and client WebSocket messages", () => {
    expect(WebSocketAuthenticationSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      type: "authenticate",
      token: "capability",
    })).toMatchObject({ type: "authenticate" });
    expect(() => WebSocketAuthenticationSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      type: "auth",
      token: "capability",
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
