import { describe, expect, it } from "vitest";
import {
  ActTaskScopeSchema,
  EvidencePathSchema,
  GraphNodeSchema,
  GraphQuerySchema,
  PROTOCOL_VERSION
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
