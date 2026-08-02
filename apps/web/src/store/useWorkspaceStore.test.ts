import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  ActTask as ContractActTask,
  GraphEdge,
  GraphNode,
  PanelState,
} from "@constelix/contracts";

import type { BootstrapPayload, EvidencePath, WorkspaceNode } from "../types";
import {
  clearEditorDraftsForTests,
  getEditorDraft,
  getOrCreateEditorDraft,
} from "../lib/editorDrafts";
import { AgentRequestError } from "../lib/api";

const apiMock = vi.hoisted(() => ({
  hasToken: true,
  commitHydratedWorkspace: vi.fn(),
  bootstrap: vi.fn(),
  queryGraph: vi.fn(),
  queryGraphPage: vi.fn(),
  queryEvidenceGraph: vi.fn(),
  deleteTerminal: vi.fn(),
  saveLayout: vi.fn(),
  ask: vi.fn(),
  createActTask: vi.fn(),
  approveActTask: vi.fn(),
  cancelActTask: vi.fn(),
  sendEvent: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  AgentRequestError: class AgentRequestError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code?: string,
    ) {
      super(message);
    }
  },
  apiClient: apiMock,
}));

vi.mock("../lib/layout", () => ({
  layoutSemanticNodes: vi.fn().mockResolvedValue({}),
  resolveSemanticLayoutCollisions: vi.fn(
    (
      _nodes: WorkspaceNode[],
      proposed: Record<string, { x: number; y: number }>,
    ) => proposed,
  ),
}));

let useWorkspaceStore: typeof import("./useWorkspaceStore")["useWorkspaceStore"];
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window",
);

beforeAll(async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      clearInterval: (id: number) => globalThis.clearInterval(id),
      clearTimeout: (id: number) => globalThis.clearTimeout(id),
      setInterval: (
        handler: TimerHandler,
        timeout?: number,
      ) => globalThis.setInterval(handler, timeout),
      setTimeout: (
        handler: TimerHandler,
        timeout?: number,
      ) => globalThis.setTimeout(handler, timeout),
      matchMedia: () => ({ matches: true }),
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
      dispatchEvent: vi.fn(),
    },
  });
  ({ useWorkspaceStore } = await import("./useWorkspaceStore"));
});

afterAll(() => {
  vi.useRealTimers();
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

beforeEach(() => {
  vi.useRealTimers();
  clearEditorDraftsForTests();
  for (const mock of Object.values(apiMock)) {
    if (typeof mock === "function" && "mockReset" in mock) {
      mock.mockReset();
    }
  }
  const initial = useWorkspaceStore.getInitialState();
  useWorkspaceStore.setState({
    ...initial,
    nodes: initial.nodes.map(cloneNode),
    edges: [...initial.edges],
  }, true);
  apiMock.deleteTerminal.mockResolvedValue(undefined);
  apiMock.saveLayout.mockResolvedValue(undefined);
  apiMock.sendEvent.mockReturnValue(true);
  apiMock.commitHydratedWorkspace.mockImplementation(
    (_sessionId: string, applyHydration?: () => void) => {
      applyHydration?.();
    },
  );
});

describe("workspace bootstrap reconciliation", () => {
  it("reconciles a workspace.changed event from another local tab", async () => {
    const switched = bootstrapPayload({
      workspaceId: "workspace-two",
      sessionId: "00000000-0000-4000-8000-000000000002",
    });
    apiMock.bootstrap.mockResolvedValue(switched);
    apiMock.commitHydratedWorkspace.mockImplementation(
      (sessionId: string, applyHydration: () => void) => {
        expect(sessionId).toBe(switched.session.id);
        expect(useWorkspaceStore.getState()).toMatchObject({
          workspaceId: "workspace-one",
          remoteHydrated: false,
        });
        applyHydration();
        expect(useWorkspaceStore.getState()).toMatchObject({
          workspaceId: "workspace-two",
          remoteHydrated: true,
        });
      },
    );
    useWorkspaceStore.setState({
      remoteHydrated: true,
      demoMode: false,
      connection: "connected",
      workspaceId: "workspace-one",
    });

    useWorkspaceStore.getState().handleAgentEvent({
      protocolVersion: 1,
      eventId: "workspace-changed",
      timestamp: "2026-07-25T12:00:00.000Z",
      type: "workspace.changed",
      sessionId: switched.session.id,
      workspaceId: switched.workspace.id,
      payload: { session: switched.session },
    });

    expect(useWorkspaceStore.getState()).toMatchObject({
      connection: "connecting",
      remoteHydrated: false,
    });
    await vi.waitFor(() => {
      expect(useWorkspaceStore.getState().workspaceId).toBe("workspace-two");
    });
    expect(apiMock.bootstrap).toHaveBeenCalledOnce();
    expect(apiMock.commitHydratedWorkspace).toHaveBeenCalledWith(
      switched.session.id,
      expect.any(Function),
    );
    expect(useWorkspaceStore.getState()).toMatchObject({
      connection: "connected",
      remoteHydrated: true,
    });
  });

  it("does not commit the transport session when bootstrap hydration fails", () => {
    const corrupted = {
      ...bootstrapPayload({
        workspaceId: "workspace-two",
        sessionId: "00000000-0000-4000-8000-000000000002",
      }),
      graph: {
        ...bootstrapPayload().graph,
        nodes: null,
      },
    } as unknown as BootstrapPayload;

    expect(() =>
      useWorkspaceStore.getState().hydrateBootstrap(corrupted),
    ).toThrow();
    expect(apiMock.commitHydratedWorkspace).not.toHaveBeenCalled();
  });

  it("drains an aborted reconciliation before resolving the changed workspace", async () => {
    const switched = bootstrapPayload({
      workspaceId: "workspace-two",
      sessionId: "00000000-0000-4000-8000-000000000002",
    });
    let firstSignal: AbortSignal | undefined;
    apiMock.bootstrap
      .mockImplementationOnce((signal: AbortSignal) => {
        firstSignal = signal;
        return new Promise<BootstrapPayload>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      })
      .mockResolvedValueOnce(switched);
    useWorkspaceStore.setState({
      remoteHydrated: true,
      demoMode: false,
      connection: "connected",
      workspaceId: "workspace-one",
    });

    const firstReconciliation =
      useWorkspaceStore.getState().reconcileGraph();
    await vi.waitFor(() => {
      expect(apiMock.bootstrap).toHaveBeenCalledOnce();
    });
    useWorkspaceStore.getState().handleAgentEvent({
      protocolVersion: 1,
      eventId: "workspace-changed-aborts-bootstrap",
      timestamp: "2026-07-25T12:00:00.000Z",
      type: "workspace.changed",
      sessionId: switched.session.id,
      workspaceId: switched.workspace.id,
      payload: { session: switched.session },
    });

    await firstReconciliation;
    expect(firstSignal?.aborted).toBe(true);
    expect(apiMock.bootstrap).toHaveBeenCalledTimes(2);
    expect(useWorkspaceStore.getState()).toMatchObject({
      workspaceId: "workspace-two",
      remoteHydrated: true,
      connection: "connected",
      graphReconciling: false,
    });
  });

  it("retries a cross-tab bootstrap while the server finishes a workspace switch", async () => {
    vi.useFakeTimers();
    const switched = bootstrapPayload({
      workspaceId: "workspace-two",
      sessionId: "00000000-0000-4000-8000-000000000002",
    });
    apiMock.bootstrap
      .mockRejectedValueOnce(
        new AgentRequestError(
          "Workspace switch is still committing.",
          409,
          "WORKSPACE_SWITCH_IN_PROGRESS",
        ),
      )
      .mockResolvedValueOnce(switched);
    useWorkspaceStore.setState({
      remoteHydrated: true,
      demoMode: false,
      connection: "connected",
      workspaceId: "workspace-one",
    });

    useWorkspaceStore.getState().handleAgentEvent({
      protocolVersion: 1,
      eventId: "workspace-changed-during-cleanup",
      timestamp: "2026-07-25T12:00:00.000Z",
      type: "workspace.changed",
      sessionId: switched.session.id,
      workspaceId: switched.workspace.id,
      payload: { session: switched.session },
    });

    expect(useWorkspaceStore.getState()).toMatchObject({
      workspaceId: "workspace-one",
      remoteHydrated: false,
      connection: "connecting",
    });
    await vi.advanceTimersByTimeAsync(150);
    await vi.waitFor(() => {
      expect(useWorkspaceStore.getState().workspaceId).toBe("workspace-two");
    });
    expect(apiMock.bootstrap).toHaveBeenCalledTimes(2);
    expect(useWorkspaceStore.getState()).toMatchObject({
      remoteHydrated: true,
      connection: "connected",
    });
  });

  it("does not let a late bootstrap overwrite a newer socket disconnection", async () => {
    const pendingBootstrap = deferred<BootstrapPayload>();
    apiMock.bootstrap.mockReturnValue(pendingBootstrap.promise);
    useWorkspaceStore.setState({
      remoteHydrated: true,
      demoMode: false,
      connection: "connected",
      graphRevision: 4,
    });

    const reconciliation = useWorkspaceStore.getState().reconcileGraph();
    useWorkspaceStore.getState().setConnection("degraded");
    pendingBootstrap.resolve(bootstrapPayload({ revision: 4 }));
    await reconciliation;

    expect(useWorkspaceStore.getState().connection).toBe("degraded");
  });

  it("preserves a newer capabilities.updated result over a stale bootstrap", async () => {
    const pendingBootstrap = deferred<BootstrapPayload>();
    apiMock.bootstrap.mockReturnValue(pendingBootstrap.promise);
    useWorkspaceStore.setState({
      remoteHydrated: true,
      demoMode: false,
      connection: "connected",
      graphRevision: 4,
      actAvailable: false,
      codexReason: "Comprobando…",
    });

    const reconciliation = useWorkspaceStore.getState().reconcileGraph();
    useWorkspaceStore.getState().handleAgentEvent({
      protocolVersion: 1,
      eventId: "capability-newer",
      timestamp: "2026-07-16T12:00:00.000Z",
      type: "capabilities.updated",
      payload: {
        act: true,
        checking: false,
        codexVersion: "0.144.5",
      },
    });
    pendingBootstrap.resolve(bootstrapPayload({
      revision: 4,
      capabilities: {
        ask: true,
        askMode: "openai",
        askProviderStatus: "ready",
        act: false,
        terminal: true,
        codexReason: "stale bootstrap",
      },
    }));
    await reconciliation;

    expect(useWorkspaceStore.getState()).toMatchObject({
      actAvailable: true,
      codexReason: undefined,
    });
  });

  it("updates Ask capabilities without changing Codex and rejects a stale bootstrap", async () => {
    const pendingBootstrap = deferred<BootstrapPayload>();
    apiMock.bootstrap.mockReturnValue(pendingBootstrap.promise);
    useWorkspaceStore.setState({
      remoteHydrated: true,
      demoMode: false,
      connection: "connected",
      graphRevision: 4,
      askMode: "openai",
      askProviderStatus: "ready",
      actAvailable: true,
      codexVersion: "0.144.5",
    });

    const reconciliation = useWorkspaceStore.getState().reconcileGraph();
    useWorkspaceStore.getState().handleAgentEvent({
      protocolVersion: 1,
      eventId: "ask-capability-newer",
      timestamp: "2026-07-16T12:00:00.000Z",
      type: "capabilities.updated",
      payload: {
        askMode: "local",
        askProviderStatus: "insufficient_quota",
        askNotice: "OpenAI no tiene cuota; la búsqueda local permanece disponible.",
      },
    });
    expect(useWorkspaceStore.getState()).toMatchObject({
      actAvailable: true,
      codexVersion: "0.144.5",
    });
    pendingBootstrap.resolve(bootstrapPayload({ revision: 4 }));
    await reconciliation;

    expect(useWorkspaceStore.getState()).toMatchObject({
      askMode: "local",
      askProviderStatus: "insufficient_quota",
      askNotice: "OpenAI no tiene cuota; la búsqueda local permanece disponible.",
      actAvailable: true,
    });

    useWorkspaceStore.getState().handleAgentEvent({
      protocolVersion: 1,
      eventId: "ask-capability-ready",
      timestamp: "2026-07-16T12:00:01.000Z",
      type: "capabilities.updated",
      payload: {
        askMode: "openai",
        askProviderStatus: "ready",
        askNotice: null,
      },
    });
    expect(useWorkspaceStore.getState()).toMatchObject({
      askMode: "openai",
      askProviderStatus: "ready",
      askNotice: undefined,
      actAvailable: true,
    });
  });

  it.each([
    ["INSUFFICIENT_QUOTA", "insufficient_quota"],
    ["INVALID_API_KEY", "invalid_api_key"],
    ["RATE_LIMITED", "rate_limited"],
    ["NETWORK_UNAVAILABLE", "network_unavailable"],
  ] as const)("preserves the %s fallback status", (code, expectedStatus) => {
    useWorkspaceStore.setState({
      askThreadId: "workspace:main",
      activeAskRequestId: "request-fallback",
      answer: "partial answer",
      assistantThinking: true,
    });

    useWorkspaceStore.getState().handleAgentEvent({
      protocolVersion: 1,
      eventId: `fallback-${code}`,
      timestamp: "2026-07-18T12:00:00.000Z",
      type: "ask.event",
      payload: {
        protocolVersion: 1,
        requestId: "request-fallback",
        threadId: "workspace:main",
        type: "fallback",
        from: "openai",
        to: "local",
        code,
        message: "La búsqueda local continuará la consulta.",
        discardPartial: true,
      },
    });

    expect(useWorkspaceStore.getState()).toMatchObject({
      askMode: "local",
      askProviderStatus: expectedStatus,
      askNotice: "La búsqueda local continuará la consulta.",
      answer: "",
      assistantThinking: true,
    });
  });

  it("resets active workspace state while retaining explicitly preserved drafts", () => {
    const workspaceA = bootstrapPayload();
    workspaceA.workspace = {
      ...workspaceA.workspace,
      id: "workspace-a",
      name: "Project A",
      rootPath: "…/Project A",
    };
    workspaceA.conversation = [
      { role: "user", content: "Question A", mode: "local" },
      { role: "assistant", content: "Answer A", mode: "local" },
    ];
    workspaceA.activeActTask = contractActTask("task-a", "running");
    workspaceA.terminals = [{
      protocolVersion: 1,
      id: "terminal-a",
      panelId: "panel-terminal",
      cwd: ".",
      shell: "/bin/zsh",
      createdAt: "2026-07-16T12:00:00.000Z",
      status: "running",
    }];
    useWorkspaceStore.getState().hydrateBootstrap(workspaceA);
    getOrCreateEditorDraft("workspace-a", "src/a.ts", {
      content: "changed",
      savedContent: "original",
      language: "typescript",
      loaded: true,
      status: "idle",
    });
    useWorkspaceStore.setState({
      question: "pending A",
      answer: "cached A",
      assistantThinking: true,
      activeAskTurnId: "turn-a",
      activeAskRequestId: "request-a",
      evidencePartial: true,
      evidenceForcedNodeIds: { "node-a": true },
    });

    const workspaceB = bootstrapPayload();
    workspaceB.workspace = {
      ...workspaceB.workspace,
      id: "workspace-b",
      name: "Project B",
      rootPath: "…/Project B",
    };
    workspaceB.conversation = [];
    workspaceB.activeAskTurnIds = [];
    workspaceB.activeActTask = null;
    workspaceB.terminals = [];
    useWorkspaceStore.getState().hydrateBootstrap(workspaceB);

    expect(useWorkspaceStore.getState()).toMatchObject({
      workspaceId: "workspace-b",
      workspaceName: "Project B",
      askThreadId: "workspace-b:main",
      conversation: [],
      question: "",
      answer: "",
      assistantThinking: false,
      activeAskTurnId: null,
      activeAskRequestId: null,
      evidencePath: null,
      evidencePartial: false,
      evidenceForcedNodeIds: {},
      actTask: null,
      terminalRuntimes: {},
    });
    expect(getEditorDraft("workspace-a", "src/a.ts")).toMatchObject({
      content: "changed",
      savedContent: "original",
    });
    expect(apiMock.deleteTerminal).not.toHaveBeenCalledWith("terminal-a");
  });

  it("keeps paginated and expanded nodes when reconnecting at the same revision", () => {
    const base = semanticNode("base");
    const paginated = semanticNode("paginated");
    useWorkspaceStore.setState({
      remoteHydrated: true,
      demoMode: false,
      connection: "degraded",
      workspaceId: "workspace-one",
      graphRevision: 7,
      nodes: [base, paginated],
      graphCursor: "v1:1000",
      expansionCursors: { base: "v1:200" },
    });

    useWorkspaceStore.getState().hydrateBootstrap(
      bootstrapPayload({
        revision: 7,
        nodes: [graphNode("base")],
        cursor: "v1:500",
      }),
    );

    expect(useWorkspaceStore.getState().nodes.map((node) => node.id)).toEqual([
      "base",
      "paginated",
    ]);
    expect(useWorkspaceStore.getState()).toMatchObject({
      graphCursor: "v1:1000",
      expansionCursors: { base: "v1:200" },
    });

    useWorkspaceStore.getState().handleAgentEvent({
      protocolVersion: 1,
      eventId: "same-revision-snapshot",
      timestamp: "2026-07-16T12:00:00.000Z",
      type: "graph.snapshot",
      payload: {
        graph: bootstrapPayload({
          revision: 7,
          nodes: [graphNode("base")],
        }).graph,
        provisional: false,
      },
    });
    expect(useWorkspaceStore.getState().nodes.map((node) => node.id)).toEqual([
      "base",
      "paginated",
    ]);
  });

  it("refreshes onboarding metadata from index progress summaries", () => {
    useWorkspaceStore.getState().handleAgentEvent({
      protocolVersion: 1,
      eventId: "index-summary",
      timestamp: "2026-07-16T12:00:00.000Z",
      type: "index.progress",
      payload: {
        phase: "scanning",
        completed: 2,
        total: 10,
        revision: 0,
        progress: 0.2,
        filesIndexed: 2,
        symbolsIndexed: 0,
        edgesIndexed: 0,
        summary: {
          projectTypes: ["Node.js", "TypeScript"],
          languages: ["typescript"],
          estimatedFileCount: 7,
          indexedFileCount: 2,
          warnings: [{
            code: "WORKSPACE_FILE_LIMIT",
            message: "El índice alcanzó su límite.",
          }],
          omittedFiles: [{
            relativePath: "src/omitted.ts",
            reason: "file_limit",
          }],
          omittedFileCount: 1,
          omittedFilesTruncated: false,
        },
      },
    });

    expect(useWorkspaceStore.getState().workspaceSummary).toMatchObject({
      projectTypes: ["Node.js", "TypeScript"],
      languages: ["typescript"],
      estimatedFileCount: 7,
      indexedFileCount: 2,
      omittedFileCount: 1,
    });
  });

  it("recovers missing evidence edges with a bidirectional graph query", async () => {
    const source = graphNode("source");
    const target = graphNode("target");
    const relation = graphEdge("source-target", "source", "target");
    apiMock.queryEvidenceGraph.mockResolvedValue({
      protocolVersion: 1,
      workspaceId: "workspace-one",
      revision: 3,
      nodes: [source, target],
      edges: [relation],
      truncated: false,
    });
    useWorkspaceStore.setState({
      remoteHydrated: true,
      demoMode: false,
      connection: "connected",
      graphRevision: 3,
      nodes: [semanticNode("source"), semanticNode("target")],
      edges: [],
    });
    const evidencePath: EvidencePath = {
      protocolVersion: 1,
      nodeIds: ["source", "target"],
      edgeIds: ["source-target"],
      evidence: [],
      complete: true,
    };

    useWorkspaceStore.getState().playEvidencePath(evidencePath);

    await vi.waitFor(() => {
      expect(useWorkspaceStore.getState().evidencePartial).toBe(false);
    });
    expect(apiMock.queryEvidenceGraph).toHaveBeenCalledWith([
      "source",
      "target",
    ]);
    expect(useWorkspaceStore.getState().edges.map((edge) => edge.id)).toContain(
      "source-target",
    );
  });

  it("retries a transient bootstrap failure while the socket remains healthy", async () => {
    vi.useFakeTimers();
    apiMock.bootstrap
      .mockRejectedValueOnce(new TypeError("temporary network failure"))
      .mockResolvedValue(bootstrapPayload({ revision: 1 }));
    useWorkspaceStore.setState({
      demoMode: false,
      connection: "connecting",
    });

    const reconciliation = useWorkspaceStore.getState().reconcileGraph();
    await vi.advanceTimersByTimeAsync(150);
    await reconciliation;

    expect(apiMock.bootstrap).toHaveBeenCalledTimes(2);
    expect(useWorkspaceStore.getState().connection).toBe("connected");
  });

  it("does not submit Ask when bootstrap reports capabilities.ask=false", async () => {
    useWorkspaceStore.setState({
      remoteHydrated: true,
      demoMode: false,
      connection: "connected",
      askAvailable: false,
      question: "¿Dónde está el índice?",
    });

    await useWorkspaceStore.getState().submitQuestion();

    expect(apiMock.ask).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().question).toBe(
      "¿Dónde está el índice?",
    );
  });

  it("restores an active Act task and keeps its id available for cancellation", async () => {
    const activeActTask = contractActTask("task-running", "running");
    apiMock.cancelActTask.mockResolvedValue({
      ...activeActTask,
      status: "cancelled",
      completedAt: "2026-07-16T12:05:00.000Z",
    });

    useWorkspaceStore.getState().hydrateBootstrap(
      bootstrapPayload({ activeActTask }),
    );

    expect(useWorkspaceStore.getState().actTask).toMatchObject({
      id: "task-running",
      status: "running",
      objective: "Complete the current task.",
    });
    await useWorkspaceStore.getState().cancelActTask();
    expect(apiMock.cancelActTask).toHaveBeenCalledWith("task-running");
    expect(useWorkspaceStore.getState().actTask?.status).toBe("cancelled");
  });

  it("docks an existing terminal without recreating its server PTY", () => {
    const runtime = {
      terminalId: "terminal-existing",
      cwd: ".",
      status: "running" as const,
    };
    useWorkspaceStore.setState({
      terminalRuntimes: { "panel-terminal": runtime },
    });

    useWorkspaceStore.getState().setPanelDock("panel-terminal", "bottom");

    const terminal = useWorkspaceStore
      .getState()
      .nodes.find((node) => node.id === "panel-terminal");
    expect(terminal?.type).toBe("terminalPanel");
    if (terminal?.type === "terminalPanel") {
      expect(terminal.data.dock).toBe("bottom");
    }
    expect(terminal?.hidden).toBe(false);
    expect(useWorkspaceStore.getState().terminalRuntimes["panel-terminal"]).toBe(
      runtime,
    );
    expect(apiMock.deleteTerminal).not.toHaveBeenCalled();
  });

  it("restores and persists the active tab for each dock", async () => {
    const timestamp = "2026-07-18T12:00:00.000Z";
    const panel = (
      id: string,
      kind: PanelState["kind"],
      dock: PanelState["dock"],
      dockActive: boolean,
      resource: PanelState["resource"],
    ): PanelState => ({
      protocolVersion: 1,
      id,
      kind,
      dock,
      dockActive,
      position: { x: 0, y: 0 },
      size: { width: 480, height: 320 },
      resource,
      zoom: 1,
      pinned: false,
      updatedAt: timestamp,
    });
    const layout = [
      panel("panel-editor", "editor", "right", false, {
        relativePath: "base.ts",
        language: "typescript",
        hidden: false,
      }),
      panel("panel-assistant", "ask", "right", true, {
        mode: "ask",
        hidden: false,
      }),
      panel("panel-terminal", "terminal", "bottom", true, {
        cwd: ".",
        hidden: false,
      }),
    ];

    useWorkspaceStore.getState().hydrateBootstrap(
      bootstrapPayload({ layout }),
    );
    const restored = useWorkspaceStore.getState().nodes;
    const editor = restored.find(({ id }) => id === "panel-editor");
    const assistant = restored.find(({ id }) => id === "panel-assistant");
    expect(assistant?.zIndex ?? 0).toBeGreaterThan(editor?.zIndex ?? 0);

    useWorkspaceStore.getState().raisePanel("panel-editor");
    await vi.waitFor(() => expect(apiMock.saveLayout).toHaveBeenCalled());
    const saved = apiMock.saveLayout.mock.calls.at(-1)?.[0] as PanelState[];
    expect(saved.find(({ id }) => id === "panel-editor")?.dockActive).toBe(
      true,
    );
    expect(saved.find(({ id }) => id === "panel-assistant")?.dockActive).toBe(
      false,
    );
    expect(saved.find(({ id }) => id === "panel-terminal")?.dockActive).toBe(
      true,
    );
  });

});

function bootstrapPayload(options: {
  revision?: number;
  nodes?: GraphNode[];
  cursor?: string;
  workspaceId?: string;
  sessionId?: string;
  capabilities?: NonNullable<BootstrapPayload["capabilities"]>;
  activeActTask?: ContractActTask | null;
  layout?: BootstrapPayload["layout"];
} = {}): BootstrapPayload {
  return {
    protocolVersion: 1,
    session: {
      id: options.sessionId ?? "00000000-0000-4000-8000-000000000001",
      workspaceId: options.workspaceId ?? "workspace-one",
      activatedAt: "2026-01-01T00:00:00.000Z",
    },
    workspace: {
      id: options.workspaceId ?? "workspace-one",
      name: "Fixture",
      rootPath: "/tmp/fixture",
      mode: "edit",
      readOnly: false,
    },
    summary: {
      projectTypes: ["TypeScript"],
      languages: ["typescript"],
      estimatedFileCount: 1,
      indexedFileCount: 1,
      warnings: [],
      omittedFiles: [],
      omittedFileCount: 0,
      omittedFilesTruncated: false,
    },
    graph: {
      protocolVersion: 1,
      workspaceId: options.workspaceId ?? "workspace-one",
      revision: options.revision ?? 1,
      nodes: options.nodes ?? [graphNode("base")],
      edges: [],
      truncated: Boolean(options.cursor),
      ...(options.cursor ? { cursor: options.cursor } : {}),
    },
    index: {
      phase: "ready",
      progress: 1,
      filesIndexed: 1,
      symbolsIndexed: 1,
      edgesIndexed: 0,
    },
    activeAskTurnIds: [],
    activeActTask: options.activeActTask ?? null,
    terminals: [],
    ...(options.layout === undefined ? {} : { layout: options.layout }),
    capabilities: options.capabilities ?? {
      ask: true,
      askMode: "openai",
      askProviderStatus: "ready",
      act: true,
      terminal: true,
    },
  };
}

function graphNode(id: string): GraphNode {
  return {
    protocolVersion: 1,
    id,
    kind: "file",
    name: id,
    qualifiedName: id,
    relativePath: `${id}.ts`,
    language: "typescript",
    revision: 1,
    metadata: {},
  };
}

function graphEdge(id: string, source: string, target: string): GraphEdge {
  return {
    protocolVersion: 1,
    id,
    source,
    target,
    relation: "imports",
    confidence: "extracted",
    evidence: [],
    revision: 1,
    metadata: {},
  };
}

function semanticNode(id: string): WorkspaceNode {
  return {
    id,
    type: "semantic",
    position: { x: 0, y: 0 },
    data: {
      kind: "file",
      label: id,
      relativePath: `${id}.ts`,
    },
  };
}

function contractActTask(
  id: string,
  status: ContractActTask["status"],
): ContractActTask {
  return {
    protocolVersion: 1,
    id,
    scope: {
      protocolVersion: 1,
      workspaceId: "workspace-one",
      rootPath: "/tmp/fixture",
      objective: "Complete the current task.",
      capabilities: ["read", "write", "command"],
      networkEnabled: true,
      outsideWorkspaceWrites: false,
      expiresAt: "2026-07-16T12:15:00.000Z",
    },
    status,
    createdAt: "2026-07-16T12:00:00.000Z",
    approvedAt: "2026-07-16T12:00:01.000Z",
  };
}

function cloneNode(node: WorkspaceNode): WorkspaceNode {
  return {
    ...node,
    position: { ...node.position },
    data: { ...node.data },
    ...(node.style ? { style: { ...node.style } } : {}),
  } as WorkspaceNode;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((resolver) => {
      resolve = resolver;
    }),
    resolve,
  };
}
