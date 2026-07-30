import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentRequestError,
  ConstelixApiClient,
  apiClient,
  buildEventSocketUrl,
  canUseKeepaliveBody,
  parseBootstrapPayload,
  parseServerEvent,
} from "./api";

vi.mock("./auth", () => ({
  readCapabilityToken: () => null,
}));

const timestamp = "2026-07-16T12:00:00.000Z";
const WORKSPACE_ONE_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const WORKSPACE_TWO_ID = "bbbbbbbbbbbbbbbbbbbbbbbb";
const WORKSPACE_THREE_ID = "cccccccccccccccccccccccc";
const workspaceSession = {
  id: "00000000-0000-4000-8000-000000000001",
  workspaceId: WORKSPACE_ONE_ID,
  activatedAt: timestamp,
};
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
  it("accepts post-handshake connection lifecycle events", () => {
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
      session: workspaceSession,
      workspace: {
        id: WORKSPACE_ONE_ID,
        name: "Fixture",
        rootPath: "/tmp/fixture",
        mode: "edit",
        readOnly: false,
      },
      summary: workspaceSummary,
      graph: {
        protocolVersion: 1,
        workspaceId: WORKSPACE_ONE_ID,
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
        session: workspaceSession,
        workspace: {
          id: WORKSPACE_ONE_ID,
          name: "Fixture",
          rootPath: "/tmp/fixture",
          mode: "edit",
          readOnly: false,
        },
        summary: workspaceSummary,
        graph: {
          protocolVersion: 1,
          workspaceId: WORKSPACE_ONE_ID,
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
    expect(() =>
      parseBootstrapPayload({
        ...payload,
        session: undefined,
      }),
    ).toThrow();
  });

  it("parses the active Act task required to recover a reloaded panel", () => {
    const bootstrap = parseBootstrapPayload({
      protocolVersion: 1,
      session: workspaceSession,
      workspace: {
        id: WORKSPACE_ONE_ID,
        name: "Fixture",
        rootPath: "/tmp/fixture",
        mode: "edit",
        readOnly: false,
      },
      summary: workspaceSummary,
      graph: {
        protocolVersion: 1,
        workspaceId: WORKSPACE_ONE_ID,
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
          workspaceId: WORKSPACE_ONE_ID,
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
        workspaceId: WORKSPACE_ONE_ID,
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

  it("authenticates the WebSocket in its handshake URL", () => {
    const url = new URL(buildEventSocketUrl(
      { protocol: "http:", host: "127.0.0.1:4321" },
      "token with symbols/+",
    ));

    expect(url.protocol).toBe("ws:");
    expect(url.pathname).toBe("/api/v1/events");
    expect(url.searchParams.get("token")).toBe("token with symbols/+");
  });

  it("quarantines scoped operations until a changed workspace is atomically hydrated", async () => {
    const first = transportBootstrap(
      "00000000-0000-4000-8000-000000000011",
      WORKSPACE_ONE_ID,
    );
    const second = transportBootstrap(
      "00000000-0000-4000-8000-000000000022",
      WORKSPACE_TWO_ID,
    );
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(first))
      .mockResolvedValueOnce(jsonResponse(second));
    vi.stubGlobal("fetch", fetchMock);
    FakeEventWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeEventWebSocket);
    vi.stubGlobal("window", {
      location: {
        protocol: "http:",
        host: "127.0.0.1:4317",
      },
      clearTimeout,
      setTimeout,
    });
    const client = new ConstelixApiClient("transition-token");
    const reconciliation = vi.fn();
    client.subscribeWorkspaceReconciliation(reconciliation);

    const initial = await client.bootstrap();
    expect(client.workspaceTransitioning).toBe(true);
    expect(client.sessionId).toBeNull();
    const rejectedHydration = vi.fn();
    expect(() =>
      client.commitHydratedWorkspace(
        "00000000-0000-4000-8000-000000000099",
        rejectedHydration,
      )
    ).toThrowError(AgentRequestError);
    expect(rejectedHydration).not.toHaveBeenCalled();
    client.commitHydratedWorkspace(initial.session.id);
    const unstagedHydration = vi.fn();
    expect(() =>
      client.commitHydratedWorkspace(
        "00000000-0000-4000-8000-000000000099",
        unstagedHydration,
      )
    ).toThrowError(AgentRequestError);
    expect(unstagedHydration).not.toHaveBeenCalled();
    const disconnect = client.connect();
    const socket = FakeEventWebSocket.instances.at(0);
    expect(socket).toBeDefined();
    socket?.open();
    socket?.receive({
      protocolVersion: 1,
      eventId: "workspace-transition-event",
      timestamp,
      type: "workspace.changed",
      sessionId: second.session.id,
      workspaceId: second.workspace.id,
      payload: { session: second.session },
    });
    socket?.receive({
      protocolVersion: 1,
      eventId: "new-session-progress-during-quarantine",
      timestamp,
      type: "capabilities.updated",
      sessionId: second.session.id,
      workspaceId: second.workspace.id,
      payload: { act: true, checking: false },
    });

    expect(client.workspaceTransitioning).toBe(true);
    expect(client.sessionId).toBe(first.session.id);
    expect(client.sendEvent({ type: "terminal.input" })).toBe(false);
    await expect(client.queryGraphPage()).rejects.toMatchObject({
      code: "WORKSPACE_TRANSITION_PENDING",
      status: 409,
    } satisfies Partial<AgentRequestError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const reconciled = await client.bootstrap();
    expect(reconciled.workspace.id).toBe(WORKSPACE_TWO_ID);
    expect(client.sessionId).toBe(first.session.id);
    expect(client.workspaceTransitioning).toBe(true);
    await expect(client.queryGraphPage()).rejects.toMatchObject({
      code: "WORKSPACE_TRANSITION_PENDING",
    });
    const bootstrapHeaders = new Headers(
      (fetchMock.mock.calls[1]?.[1] as RequestInit).headers,
    );
    expect(
      bootstrapHeaders.has("X-Constelix-Workspace-Session"),
    ).toBe(false);
    client.commitHydratedWorkspace(reconciled.session.id);
    expect(client.sessionId).toBe(second.session.id);
    expect(client.workspaceTransitioning).toBe(false);
    await vi.waitFor(() => {
      expect(reconciliation).toHaveBeenCalledOnce();
    });
    disconnect();
  });

  it("recovers a workspace change missed while the event socket was disconnected", async () => {
    const first = transportBootstrap(
      "00000000-0000-4000-8000-000000000033",
      WORKSPACE_ONE_ID,
    );
    const second = transportBootstrap(
      "00000000-0000-4000-8000-000000000044",
      WORKSPACE_TWO_ID,
    );
    const changedResponse = new Response(JSON.stringify({
      protocolVersion: 1,
      error: {
        code: "WORKSPACE_SESSION_CHANGED",
        message: "The active workspace changed.",
        recoverable: true,
        details: { activeSession: second.session },
      },
    }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(first))
      .mockResolvedValueOnce(changedResponse)
      .mockResolvedValueOnce(jsonResponse(second));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ConstelixApiClient("reconnect-token");

    const initial = await client.bootstrap();
    client.commitHydratedWorkspace(initial.session.id);
    await expect(client.bootstrap()).rejects.toMatchObject({
      code: "WORKSPACE_SESSION_CHANGED",
      status: 409,
    });
    expect(client.sessionId).toBe(first.session.id);
    expect(client.workspaceTransitioning).toBe(true);

    const recovered = await client.bootstrap();
    const recoveryHeaders = new Headers(
      (fetchMock.mock.calls[2]?.[1] as RequestInit).headers,
    );
    expect(
      recoveryHeaders.has("X-Constelix-Workspace-Session"),
    ).toBe(false);
    expect(client.sessionId).toBe(first.session.id);
    expect(client.workspaceTransitioning).toBe(true);
    client.commitHydratedWorkspace(recovered.session.id);
    expect(client.sessionId).toBe(second.session.id);
    expect(client.workspaceTransitioning).toBe(false);
  });

  it("rejects a stale bootstrap and quarantines old-session socket events", async () => {
    const first = transportBootstrap(
      "00000000-0000-4000-8000-000000000055",
      WORKSPACE_ONE_ID,
    );
    const second = transportBootstrap(
      "00000000-0000-4000-8000-000000000066",
      WORKSPACE_TWO_ID,
    );
    const staleResponse = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(first))
      .mockReturnValueOnce(staleResponse.promise);
    vi.stubGlobal("fetch", fetchMock);
    FakeEventWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeEventWebSocket);
    vi.stubGlobal("window", {
      location: {
        protocol: "http:",
        host: "127.0.0.1:4317",
      },
      clearTimeout,
      setTimeout,
    });
    const client = new ConstelixApiClient("stale-bootstrap-token");
    const initial = await client.bootstrap();
    client.commitHydratedWorkspace(initial.session.id);
    const listener = vi.fn();
    const reconciliation = vi.fn();
    client.subscribe(listener);
    client.subscribeWorkspaceReconciliation(reconciliation);
    const disconnect = client.connect();
    const socket = FakeEventWebSocket.instances.at(0);
    socket?.open();

    const inFlightBootstrap = client.bootstrap();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    socket?.receive({
      protocolVersion: 1,
      eventId: "workspace-newer-than-bootstrap",
      timestamp,
      type: "workspace.changed",
      sessionId: second.session.id,
      workspaceId: second.workspace.id,
      payload: { session: second.session },
    });
    socket?.receive({
      protocolVersion: 1,
      eventId: "old-workspace-capabilities",
      timestamp,
      type: "capabilities.updated",
      sessionId: first.session.id,
      workspaceId: first.workspace.id,
      payload: { act: true, checking: false },
    });
    staleResponse.resolve(jsonResponse(first));

    await expect(inFlightBootstrap).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "workspace.changed" }),
    );
    expect(client.sessionId).toBe(first.session.id);
    expect(client.workspaceTransitioning).toBe(true);
    const applied = vi.fn();
    client.commitHydratedWorkspace(second.session.id, applied);
    expect(applied).toHaveBeenCalledOnce();
    expect(client.sessionId).toBe(second.session.id);
    await Promise.resolve();
    expect(reconciliation).not.toHaveBeenCalled();
    disconnect();
  });

  it("does not let a late open response replace a newer pending session", async () => {
    const first = transportBootstrap(
      "00000000-0000-4000-8000-000000000077",
      WORKSPACE_ONE_ID,
    );
    const late = transportBootstrap(
      "00000000-0000-4000-8000-000000000088",
      WORKSPACE_TWO_ID,
    );
    const newest = transportBootstrap(
      "00000000-0000-4000-8000-000000000099",
      WORKSPACE_THREE_ID,
    );
    const lateOpenResponse = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(first))
      .mockReturnValueOnce(lateOpenResponse.promise);
    vi.stubGlobal("fetch", fetchMock);
    FakeEventWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeEventWebSocket);
    vi.stubGlobal("window", {
      location: {
        protocol: "http:",
        host: "127.0.0.1:4317",
      },
      clearTimeout,
      setTimeout,
    });
    const client = new ConstelixApiClient("late-open-token");
    const initial = await client.bootstrap();
    client.commitHydratedWorkspace(initial.session.id);
    const disconnect = client.connect();
    const socket = FakeEventWebSocket.instances.at(0);
    socket?.open();

    const openRequest = client.openWorkspace({
      protocolVersion: 1,
      requestId: "17384852-376d-4a5d-9476-59d1070f0f8b",
      expectedSessionId: initial.session.id,
      target: { kind: "path", path: "/tmp/workspace-two" },
    });
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    socket?.receive({
      protocolVersion: 1,
      eventId: "newer-workspace-open",
      timestamp,
      type: "workspace.changed",
      sessionId: newest.session.id,
      workspaceId: newest.workspace.id,
      payload: { session: newest.session },
    });
    lateOpenResponse.resolve(jsonResponse({
      protocolVersion: 1,
      session: late.session,
      bootstrap: late,
    }));

    await expect(openRequest).rejects.toMatchObject({ name: "AbortError" });
    expect(client.sessionId).toBe(first.session.id);
    expect(client.workspaceTransitioning).toBe(true);
    client.commitHydratedWorkspace(newest.session.id);
    expect(client.sessionId).toBe(newest.session.id);
    disconnect();
  });

  it("rejects a stale error body before adopting its advertised session", async () => {
    const first = transportBootstrap(
      "10000000-0000-4000-8000-000000000001",
      WORKSPACE_ONE_ID,
    );
    const obsolete = transportBootstrap(
      "20000000-0000-4000-8000-000000000002",
      WORKSPACE_TWO_ID,
    );
    const newest = transportBootstrap(
      "30000000-0000-4000-8000-000000000003",
      WORKSPACE_THREE_ID,
    );
    const delayedDetail = deferred<string>();
    const conflictResponse = new Response(null, {
      status: 409,
      headers: { "content-type": "application/json" },
    });
    vi.spyOn(conflictResponse, "text").mockReturnValue(delayedDetail.promise);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(first))
      .mockResolvedValueOnce(conflictResponse);
    vi.stubGlobal("fetch", fetchMock);
    FakeEventWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeEventWebSocket);
    vi.stubGlobal("window", {
      location: {
        protocol: "http:",
        host: "127.0.0.1:4317",
      },
      clearTimeout,
      setTimeout,
    });
    const client = new ConstelixApiClient("stale-error-token");
    const initial = await client.bootstrap();
    client.commitHydratedWorkspace(initial.session.id);
    const disconnect = client.connect();
    const socket = FakeEventWebSocket.instances.at(0);
    socket?.open();

    const bootstrapRequest = client.bootstrap();
    await vi.waitFor(() => {
      expect(conflictResponse.text).toHaveBeenCalledOnce();
    });
    socket?.receive({
      protocolVersion: 1,
      eventId: "newer-than-error-body",
      timestamp,
      type: "workspace.changed",
      sessionId: newest.session.id,
      workspaceId: newest.workspace.id,
      payload: { session: newest.session },
    });
    delayedDetail.resolve(JSON.stringify({
      protocolVersion: 1,
      error: {
        code: "WORKSPACE_SESSION_CHANGED",
        message: "An obsolete session was advertised.",
        recoverable: true,
        details: { activeSession: obsolete.session },
      },
    }));

    await expect(bootstrapRequest).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(client.sessionId).toBe(first.session.id);
    expect(client.workspaceTransitioning).toBe(true);
    client.commitHydratedWorkspace(newest.session.id);
    expect(client.sessionId).toBe(newest.session.id);
    disconnect();
  });

  it("reads and updates only the public LLM configuration", async () => {
    const configuration = {
      protocolVersion: 1 as const,
      baseUrl: "http://localhost:11434/v1",
      model: "qwen2.5-coder",
      providerKind: "ollama" as const,
      apiKeyConfigured: false,
      apiKeyRequired: false,
      apiKeySource: "none" as const,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(configuration), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(configuration), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiClient.getLlmConfiguration()).resolves.toEqual(configuration);
    await expect(apiClient.updateLlmConfiguration({
      protocolVersion: 1,
      baseUrl: configuration.baseUrl,
      model: configuration.model,
      apiKey: { action: "preserve" },
    })).resolves.toEqual(configuration);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/settings/llm");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/settings/llm");
    const updateRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(updateRequest.method).toBe("PUT");
    expect(JSON.parse(String(updateRequest.body))).not.toHaveProperty("apiKey.value");
  });
});

class FakeEventWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeEventWebSocket[] = [];

  readyState = FakeEventWebSocket.CONNECTING;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    super();
    FakeEventWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeEventWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(value: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(value) }),
    );
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    if (this.readyState === FakeEventWebSocket.CLOSED) return;
    this.readyState = FakeEventWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

function transportBootstrap(sessionId: string, workspaceId: string) {
  return {
    protocolVersion: 1 as const,
    session: {
      id: sessionId,
      workspaceId,
      activatedAt: timestamp,
    },
    workspace: {
      id: workspaceId,
      name: workspaceId,
      rootPath: `/tmp/${workspaceId}`,
      mode: "edit" as const,
      readOnly: false,
    },
    summary: workspaceSummary,
    graph: {
      protocolVersion: 1 as const,
      workspaceId,
      revision: 1,
      nodes: [],
      edges: [],
      truncated: false,
    },
    index: {
      phase: "ready" as const,
      progress: 1,
      filesIndexed: 1,
      symbolsIndexed: 1,
      edgesIndexed: 0,
    },
    activeAskTurnIds: [],
    activeActTask: null,
    terminals: [],
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
