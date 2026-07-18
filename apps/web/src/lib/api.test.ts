import { afterEach, describe, expect, it, vi } from "vitest";

import {
  apiClient,
  canUseKeepaliveBody,
  parseBootstrapPayload,
  parseServerEvent,
} from "./api";

vi.mock("./auth", () => ({
  readCapabilityToken: () => null,
}));

const timestamp = "2026-07-16T12:00:00.000Z";
const workspaceSummary = {
  projectTypes: ["TypeScript"],
  languages: ["typescript"],
  estimatedFileCount: 1,
  indexedFileCount: 1,
  warnings: [],
  omittedFiles: [],
  omittedFileCount: 0,
  omittedFilesTruncated: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("strict local-agent transport", () => {
  it("accepts authenticated connection lifecycle events", () => {
    expect(
      parseServerEvent({
        protocolVersion: 1,
        eventId: "event-authenticated",
        timestamp,
        type: "authenticated",
        payload: {},
      }),
    ).toMatchObject({ type: "authenticated" });
    expect(
      parseServerEvent({
        protocolVersion: 1,
        eventId: "event-ready",
        timestamp,
        type: "connection.ready",
        payload: {},
      }),
    ).toMatchObject({ type: "connection.ready" });
    expect(
      parseServerEvent({
        protocolVersion: 1,
        eventId: "event-capabilities",
        timestamp,
        type: "capabilities.updated",
        payload: {
          act: true,
          checking: false,
          codexVersion: "0.144.5",
        },
      }),
    ).toMatchObject({
      type: "capabilities.updated",
      payload: { act: true, checking: false },
    });
  });

  it("rejects legacy flattened events and snapshots", () => {
    expect(
      parseServerEvent({
        protocolVersion: 1,
        type: "ask.delta",
        threadId: "thread-one",
        delta: "legacy",
      }),
    ).toBeNull();
    expect(
      parseServerEvent({
        protocolVersion: 1,
        type: "graph.snapshot",
        graph: {
          protocolVersion: 1,
          revision: 1,
          nodes: [],
          edges: [],
          truncated: false,
        },
      }),
    ).toBeNull();
  });

  it("accepts a completed Ask event only with its canonical answer", () => {
    expect(
      parseServerEvent({
        protocolVersion: 1,
        eventId: "event-ask-completed",
        timestamp,
        type: "ask.event",
        payload: {
          protocolVersion: 1,
          requestId: "request-one",
          threadId: "thread-one",
          type: "completed",
          mode: "openai",
          responseId: "response-one",
          answer: "Respuesta completa y reconciliable.",
          evidence: {
            protocolVersion: 1,
            nodeIds: ["node-one"],
            edgeIds: [],
            evidence: [],
            complete: true,
          },
        },
      }),
    ).toMatchObject({
      type: "ask.event",
      payload: {
        type: "completed",
        answer: "Respuesta completa y reconciliable.",
        evidence: {
          nodeIds: ["node-one"],
        },
      },
    });
    expect(
      parseServerEvent({
        protocolVersion: 1,
        eventId: "event-ask-incomplete",
        timestamp,
        type: "ask.event",
        payload: {
          protocolVersion: 1,
          requestId: "request-one",
          threadId: "thread-one",
          type: "completed",
        },
      }),
    ).toBeNull();
  });

  it("requires active Ask turns in the bootstrap payload", () => {
    const payload = {
      protocolVersion: 1,
      workspace: {
        id: "workspace-one",
        name: "Fixture",
        rootPath: "/tmp/fixture",
        mode: "edit",
        readOnly: false,
      },
      summary: workspaceSummary,
      graph: {
        protocolVersion: 1,
        workspaceId: "workspace-one",
        revision: 1,
        nodes: [],
        edges: [],
        truncated: false,
      },
      index: {
        phase: "ready",
        progress: 1,
        filesIndexed: 1,
        symbolsIndexed: 2,
        edgesIndexed: 1,
      },
      activeAskTurnIds: ["turn-active"],
      activeActTask: null,
      terminals: [],
    };
    const bootstrap = parseBootstrapPayload(payload);

    expect(bootstrap.activeAskTurnIds).toEqual(["turn-active"]);
    expect(bootstrap.workspace.readOnly).toBe(false);
    expect(() =>
      parseBootstrapPayload({
        ...payload,
        workspace: { ...payload.workspace, mode: "read" },
      }),
    ).toThrow(/inconsistente/);
    expect(() =>
      parseBootstrapPayload({
        protocolVersion: 1,
        workspace: {
          id: "workspace-one",
          name: "Fixture",
          rootPath: "/tmp/fixture",
          mode: "edit",
          readOnly: false,
        },
        summary: workspaceSummary,
        graph: {
          protocolVersion: 1,
          workspaceId: "workspace-one",
          revision: 1,
          nodes: [],
          edges: [],
          truncated: false,
        },
        index: {
          phase: "ready",
          progress: 1,
          filesIndexed: 1,
          symbolsIndexed: 2,
          edgesIndexed: 1,
        },
        activeActTask: null,
        terminals: [],
      }),
    ).toThrow(/activeAskTurnIds/);
  });

  it("parses the active Act task required to recover a reloaded panel", () => {
    const bootstrap = parseBootstrapPayload({
      protocolVersion: 1,
      workspace: {
        id: "workspace-one",
        name: "Fixture",
        rootPath: "/tmp/fixture",
        mode: "edit",
        readOnly: false,
      },
      summary: workspaceSummary,
      graph: {
        protocolVersion: 1,
        workspaceId: "workspace-one",
        revision: 1,
        nodes: [],
        edges: [],
        truncated: false,
      },
      index: {
        phase: "ready",
        progress: 1,
        filesIndexed: 1,
        symbolsIndexed: 2,
        edgesIndexed: 1,
      },
      activeAskTurnIds: [],
      activeActTask: {
        protocolVersion: 1,
        id: "task-active",
        scope: {
          protocolVersion: 1,
          workspaceId: "workspace-one",
          rootPath: "/tmp/fixture",
          objective: "Continue the approved task.",
          capabilities: ["read", "write", "command"],
          networkEnabled: true,
          outsideWorkspaceWrites: false,
          expiresAt: "2026-07-16T12:15:00.000Z",
        },
        status: "running",
        createdAt: "2026-07-16T12:00:00.000Z",
        approvedAt: "2026-07-16T12:00:01.000Z",
      },
      terminals: [],
      capabilities: {
        ask: true,
        askMode: "openai",
        askProviderStatus: "ready",
        act: true,
        terminal: true,
      },
    });

    expect(bootstrap.activeActTask).toMatchObject({
      id: "task-active",
      status: "running",
    });
  });

  it("requests both inbound and outbound relations when recovering evidence", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        protocolVersion: 1,
        workspaceId: "workspace-one",
        revision: 1,
        nodes: [],
        edges: [],
        truncated: false,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await apiClient.queryEvidenceGraph(["source", "target"]);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      rootIds: ["source", "target"],
      direction: "both",
      depth: 1,
    });
  });

  it("avoids browser keepalive limits for oversized layout payloads", () => {
    expect(canUseKeepaliveBody("small layout")).toBe(true);
    expect(canUseKeepaliveBody("x".repeat(61 * 1024))).toBe(false);
  });
});
