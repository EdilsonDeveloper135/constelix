import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearEditorDraftsForTests,
  getEditorDraft,
  getOrCreateEditorDraft,
} from "../lib/editorDrafts";

const WORKSPACE_A_ID = "111111111111111111111111";
const WORKSPACE_B_ID = "222222222222222222222222";
const WORKSPACE_C_ID = "333333333333333333333333";
const SESSION_A_ID = "161c08c7-ad9b-47df-94b7-86db634a1f4f";
const SESSION_B_ID = "3c4fb9db-4cb4-44b5-91d4-6eb0a97d9ea7";
const SESSION_C_ID = "5b4ea2b9-683f-4fa4-a803-5da2f8453b86";

const targetB = {
  kind: "path",
  path: "/tmp/Proyecto B",
} as const;
const targetC = {
  kind: "recent",
  workspaceId: WORKSPACE_C_ID,
} as const;

const apiMock = vi.hoisted(() => ({
  sessionId: "161c08c7-ad9b-47df-94b7-86db634a1f4f" as string | null,
  workspaceTransitioning: false,
  listWorkspaces: vi.fn(),
  browseDirectories: vi.fn(),
  openWorkspace: vi.fn(),
}));

const workspaceMock = vi.hoisted(() => ({
  workspaceId: "111111111111111111111111",
  remoteHydrated: true,
  actTask: undefined as
    | { status: "running" | "cancelling" | "completed" }
    | undefined,
  saveLayoutNow: vi.fn(),
  cancelQuestion: vi.fn(),
  hydrateBootstrap: vi.fn(),
  reconcileGraph: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  AgentRequestError: class AgentRequestError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code?: string,
      readonly recoverable = true,
      readonly severity: "info" | "warning" | "error" = "error",
      readonly details?: unknown,
    ) {
      super(message);
      this.name = "AgentRequestError";
    }
  },
  apiClient: apiMock,
}));

vi.mock("./useWorkspaceStore", () => ({
  useWorkspaceStore: {
    getState: () => workspaceMock,
  },
}));

import { AgentRequestError } from "../lib/api";
import { useWorkspaceManagerStore } from "./useWorkspaceManagerStore";

const initialManagerState = useWorkspaceManagerStore.getInitialState();

beforeEach(() => {
  clearEditorDraftsForTests();
  vi.clearAllMocks();

  apiMock.sessionId = SESSION_A_ID;
  apiMock.workspaceTransitioning = false;
  workspaceMock.workspaceId = WORKSPACE_A_ID;
  workspaceMock.remoteHydrated = true;
  workspaceMock.actTask = undefined;
  workspaceMock.saveLayoutNow.mockResolvedValue(undefined);
  workspaceMock.reconcileGraph.mockResolvedValue(undefined);
  apiMock.listWorkspaces.mockResolvedValue({
    protocolVersion: 1,
    activeSession: session(SESSION_A_ID, WORKSPACE_A_ID),
    recents: [],
  });
  apiMock.openWorkspace.mockResolvedValue(
    openResponse(SESSION_B_ID, WORKSPACE_B_ID),
  );

  useWorkspaceManagerStore.setState({
    ...initialManagerState,
    selectorOpen: false,
    phase: "idle",
    recents: [],
    pathDraft: "",
    browse: null,
    browseLoading: false,
    errorCode: undefined,
    errorMessage: undefined,
    pendingTarget: undefined,
    guardSourceWorkspaceId: undefined,
    guardSourceSessionId: undefined,
    lockConflict: undefined,
  }, true);
});

describe("workspace manager transitions", () => {
  it("switches from workspace A to B and hydrates only after activation", async () => {
    useWorkspaceManagerStore.setState({ selectorOpen: true });

    await useWorkspaceManagerStore.getState().requestSwitch(targetB);

    expect(workspaceMock.saveLayoutNow).toHaveBeenCalledOnce();
    expect(workspaceMock.cancelQuestion).toHaveBeenCalledOnce();
    expect(apiMock.openWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      protocolVersion: 1,
      requestId: expect.any(String),
      expectedSessionId: SESSION_A_ID,
      target: targetB,
    }));
    expect(workspaceMock.hydrateBootstrap).toHaveBeenCalledOnce();
    expect(workspaceMock.hydrateBootstrap).toHaveBeenCalledWith(
      bootstrapFor(SESSION_B_ID, WORKSPACE_B_ID),
    );
    expect(useWorkspaceManagerStore.getState()).toMatchObject({
      selectorOpen: false,
      phase: "idle",
      pendingTarget: undefined,
      errorCode: undefined,
      errorMessage: undefined,
    });
  });

  it("preserves dirty editor drafts when the user explicitly chooses preserve", async () => {
    createDirtyDraft("src/preserve.ts");

    await useWorkspaceManagerStore.getState().requestSwitch(targetB);

    expect(useWorkspaceManagerStore.getState()).toMatchObject({
      phase: "dirtyGuard",
      pendingTarget: targetB,
    });
    expect(apiMock.openWorkspace).not.toHaveBeenCalled();

    await useWorkspaceManagerStore
      .getState()
      .confirmDirtyDrafts("preserve");

    expect(getEditorDraft(WORKSPACE_A_ID, "src/preserve.ts")).toMatchObject({
      content: "const state = 'changed';",
      savedContent: "const state = 'saved';",
    });
    expect(apiMock.openWorkspace).toHaveBeenCalledOnce();
    expect(useWorkspaceManagerStore.getState().phase).toBe("idle");
  });

  it("discards dirty editor drafts only after explicit confirmation", async () => {
    createDirtyDraft("src/discard.ts");

    await useWorkspaceManagerStore.getState().requestSwitch(targetB);
    expect(getEditorDraft(WORKSPACE_A_ID, "src/discard.ts")).toBeDefined();

    await useWorkspaceManagerStore
      .getState()
      .confirmDirtyDrafts("discard");

    expect(getEditorDraft(WORKSPACE_A_ID, "src/discard.ts")).toBeUndefined();
    expect(apiMock.openWorkspace).toHaveBeenCalledOnce();
    expect(useWorkspaceManagerStore.getState().phase).toBe("idle");
  });

  it("invalidates a dirty guard when another tab changes the workspace", async () => {
    createDirtyDraft("src/from-a.ts");
    createDirtyDraft("src/from-b.ts", WORKSPACE_B_ID);

    await useWorkspaceManagerStore.getState().requestSwitch(targetB);
    expect(useWorkspaceManagerStore.getState()).toMatchObject({
      phase: "dirtyGuard",
      guardSourceWorkspaceId: WORKSPACE_A_ID,
      guardSourceSessionId: SESSION_A_ID,
    });

    workspaceMock.workspaceId = WORKSPACE_B_ID;
    apiMock.sessionId = SESSION_B_ID;
    await useWorkspaceManagerStore
      .getState()
      .confirmDirtyDrafts("discard");

    expect(getEditorDraft(WORKSPACE_A_ID, "src/from-a.ts")).toBeDefined();
    expect(getEditorDraft(WORKSPACE_B_ID, "src/from-b.ts")).toBeDefined();
    expect(apiMock.openWorkspace).not.toHaveBeenCalled();
    expect(useWorkspaceManagerStore.getState()).toMatchObject({
      phase: "error",
      pendingTarget: undefined,
      guardSourceWorkspaceId: undefined,
      guardSourceSessionId: undefined,
      errorCode: "WORKSPACE_GUARD_STALE",
    });
  });

  it("revalidates an Act task before confirming a guarded switch", async () => {
    createDirtyDraft("src/guarded.ts");
    await useWorkspaceManagerStore.getState().requestSwitch(targetB);

    workspaceMock.actTask = { status: "running" };
    await useWorkspaceManagerStore
      .getState()
      .confirmDirtyDrafts("preserve");

    expect(apiMock.openWorkspace).not.toHaveBeenCalled();
    expect(useWorkspaceManagerStore.getState()).toMatchObject({
      phase: "error",
      pendingTarget: undefined,
      errorCode: "ACT_TASK_RUNNING",
    });
  });

  it("keeps the newest browse page when an older response arrives late", async () => {
    const lateBrowse = deferred<typeof browseA>();
    apiMock.browseDirectories
      .mockReturnValueOnce(lateBrowse.promise)
      .mockResolvedValueOnce(browseB);

    const firstRequest = useWorkspaceManagerStore
      .getState()
      .browsePath(browseA.path);
    await vi.waitFor(() => {
      expect(apiMock.browseDirectories).toHaveBeenCalledTimes(1);
    });
    await useWorkspaceManagerStore.getState().browsePath(browseB.path);

    lateBrowse.resolve(browseA);
    await firstRequest;

    expect(useWorkspaceManagerStore.getState()).toMatchObject({
      browse: browseB,
      pathDraft: browseB.path,
      browseLoading: false,
      errorCode: undefined,
      errorMessage: undefined,
    });
  });

  it("keeps a path typed while the initial directory browse is in flight", async () => {
    const initialBrowse = deferred<typeof browseA>();
    apiMock.browseDirectories.mockReturnValueOnce(initialBrowse.promise);
    useWorkspaceManagerStore.setState({
      browse: browseB,
      pathDraft: browseB.path,
    });

    const browseRequest = useWorkspaceManagerStore
      .getState()
      .browsePath("");
    await vi.waitFor(() => {
      expect(apiMock.browseDirectories).toHaveBeenCalledOnce();
    });

    useWorkspaceManagerStore
      .getState()
      .setPathDraft("/tmp/many-folders");
    initialBrowse.resolve(browseA);
    await browseRequest;

    expect(useWorkspaceManagerStore.getState()).toMatchObject({
      browse: browseB,
      pathDraft: "/tmp/many-folders",
      browseLoading: false,
    });
  });

  it("appends directory pages with the same signed cursor context", async () => {
    apiMock.browseDirectories
      .mockResolvedValueOnce(browseFirstPage)
      .mockResolvedValueOnce(browseSecondPage);

    await useWorkspaceManagerStore
      .getState()
      .browsePath(browseFirstPage.path, true);
    await useWorkspaceManagerStore.getState().loadMoreBrowse();

    expect(apiMock.browseDirectories).toHaveBeenNthCalledWith(
      2,
      browseFirstPage.path,
      {
        showHidden: true,
        cursor: browseFirstPage.cursor,
      },
    );
    expect(useWorkspaceManagerStore.getState().browse).toEqual({
      ...browseSecondPage,
      entries: [
        ...browseFirstPage.entries,
        browseSecondPage.entries[1],
      ],
    });
    expect(useWorkspaceManagerStore.getState()).toMatchObject({
      browseLoading: false,
      browseShowHidden: true,
      errorCode: undefined,
      errorMessage: undefined,
    });
  });

  it("discards an obsolete appended page after navigating elsewhere", async () => {
    const latePage = deferred<typeof browseSecondPage>();
    apiMock.browseDirectories
      .mockResolvedValueOnce(browseFirstPage)
      .mockReturnValueOnce(latePage.promise)
      .mockResolvedValueOnce(browseB);

    await useWorkspaceManagerStore
      .getState()
      .browsePath(browseFirstPage.path);
    const appendRequest = useWorkspaceManagerStore
      .getState()
      .loadMoreBrowse();
    await vi.waitFor(() => {
      expect(apiMock.browseDirectories).toHaveBeenCalledTimes(2);
    });
    await useWorkspaceManagerStore.getState().browsePath(browseB.path);

    latePage.resolve(browseSecondPage);
    await appendRequest;

    expect(useWorkspaceManagerStore.getState()).toMatchObject({
      browse: browseB,
      pathDraft: browseB.path,
      browseLoading: false,
    });
  });

  it("does not let a late recent-workspace response overwrite activation", async () => {
    const lateRecents = deferred<{
      protocolVersion: 1;
      activeSession: ReturnType<typeof session>;
      recents: never[];
    }>();
    const pendingOpen = deferred<ReturnType<typeof openResponse>>();
    apiMock.listWorkspaces.mockReturnValueOnce(lateRecents.promise);
    apiMock.openWorkspace.mockReturnValueOnce(pendingOpen.promise);

    const selectorRequest = useWorkspaceManagerStore
      .getState()
      .openSelector();
    const switchRequest = useWorkspaceManagerStore
      .getState()
      .requestSwitch(targetB);
    await vi.waitFor(() => {
      expect(useWorkspaceManagerStore.getState().phase).toBe("activating");
    });

    lateRecents.resolve({
      protocolVersion: 1,
      activeSession: session(SESSION_A_ID, WORKSPACE_A_ID),
      recents: [],
    });
    await selectorRequest;
    expect(useWorkspaceManagerStore.getState().phase).toBe("activating");

    pendingOpen.resolve(openResponse(SESSION_B_ID, WORKSPACE_B_ID));
    await switchRequest;
    expect(useWorkspaceManagerStore.getState().phase).toBe("idle");
  });

  it("does not overwrite a path typed while the selector is loading", async () => {
    const pendingWorkspaces = deferred<{
      protocolVersion: 1;
      activeSession: ReturnType<typeof session>;
      recents: never[];
    }>();
    const pendingBrowse = deferred<typeof browseA>();
    apiMock.listWorkspaces.mockReturnValueOnce(pendingWorkspaces.promise);
    apiMock.browseDirectories.mockReturnValueOnce(pendingBrowse.promise);

    const selectorRequest = useWorkspaceManagerStore
      .getState()
      .openSelector();
    await vi.waitFor(() => {
      expect(apiMock.browseDirectories).toHaveBeenCalledOnce();
    });
    useWorkspaceManagerStore
      .getState()
      .setPathDraft("/tmp/many-folders");

    pendingWorkspaces.resolve({
      protocolVersion: 1,
      activeSession: session(SESSION_A_ID, WORKSPACE_A_ID),
      recents: [],
    });
    pendingBrowse.resolve(browseA);
    await selectorRequest;

    expect(useWorkspaceManagerStore.getState()).toMatchObject({
      phase: "idle",
      browse: browseA,
      pathDraft: "/tmp/many-folders",
    });
  });

  it("ignores an obsolete browse error after a newer request succeeds", async () => {
    const lateBrowse = deferred<typeof browseA>();
    apiMock.browseDirectories
      .mockReturnValueOnce(lateBrowse.promise)
      .mockResolvedValueOnce(browseB);

    const firstRequest = useWorkspaceManagerStore
      .getState()
      .browsePath(browseA.path);
    await vi.waitFor(() => {
      expect(apiMock.browseDirectories).toHaveBeenCalledTimes(1);
    });
    await useWorkspaceManagerStore.getState().browsePath(browseB.path);

    lateBrowse.reject(new AgentRequestError(
      "La carpeta anterior dejó de existir.",
      404,
      "WORKSPACE_PATH_NOT_FOUND",
    ));
    await firstRequest;

    expect(useWorkspaceManagerStore.getState()).toMatchObject({
      browse: browseB,
      pathDraft: browseB.path,
      browseLoading: false,
      errorCode: undefined,
      errorMessage: undefined,
    });
  });

  it("keeps the newest workspace when an earlier switch resolves late", async () => {
    const lateOpenB = deferred<ReturnType<typeof openResponse>>();
    const openC = deferred<ReturnType<typeof openResponse>>();
    const bootstrapC = bootstrapFor(SESSION_C_ID, WORKSPACE_C_ID);
    createDirtyDraft("src/concurrent.ts");
    apiMock.openWorkspace
      .mockReturnValueOnce(lateOpenB.promise)
      .mockReturnValueOnce(openC.promise);

    await useWorkspaceManagerStore.getState().requestSwitch(targetB);

    const firstSwitch = useWorkspaceManagerStore
      .getState()
      .confirmDirtyDrafts("preserve");
    await vi.waitFor(() => {
      expect(apiMock.openWorkspace).toHaveBeenCalledTimes(1);
    });

    // Reproduce a rapid follow-up selection while the first activation is in
    // flight. The request epoch must make the late B response harmless.
    useWorkspaceManagerStore.setState({
      phase: "dirtyGuard",
      pendingTarget: targetC,
    });
    const secondSwitch = useWorkspaceManagerStore
      .getState()
      .confirmDirtyDrafts("preserve");
    await vi.waitFor(() => {
      expect(apiMock.openWorkspace).toHaveBeenCalledTimes(2);
    });
    openC.resolve(openResponse(SESSION_C_ID, WORKSPACE_C_ID));
    await secondSwitch;

    lateOpenB.resolve(openResponse(SESSION_B_ID, WORKSPACE_B_ID));
    await firstSwitch;

    expect(workspaceMock.hydrateBootstrap).toHaveBeenCalledOnce();
    expect(workspaceMock.hydrateBootstrap).toHaveBeenCalledWith(bootstrapC);
    expect(workspaceMock.reconcileGraph).toHaveBeenCalledOnce();
    expect(useWorkspaceManagerStore.getState()).toMatchObject({
      phase: "idle",
      pendingTarget: undefined,
      errorCode: undefined,
      errorMessage: undefined,
    });
  });

  it("treats an epoch-aborted open as an authoritative workspace change", async () => {
    apiMock.openWorkspace.mockRejectedValueOnce(
      new DOMException(
        "La respuesta pertenece a una sesión anterior.",
        "AbortError",
      ),
    );
    workspaceMock.reconcileGraph.mockImplementationOnce(async () => {
      workspaceMock.workspaceId = WORKSPACE_B_ID;
      workspaceMock.remoteHydrated = true;
      apiMock.sessionId = SESSION_B_ID;
    });
    useWorkspaceManagerStore.setState({ selectorOpen: true });

    await useWorkspaceManagerStore.getState().requestSwitch(targetB);

    expect(workspaceMock.reconcileGraph).toHaveBeenCalledOnce();
    expect(useWorkspaceManagerStore.getState()).toMatchObject({
      selectorOpen: false,
      phase: "idle",
      pendingTarget: undefined,
      guardSourceWorkspaceId: undefined,
      guardSourceSessionId: undefined,
      errorCode: undefined,
      errorMessage: undefined,
    });
  });

  it("reports a switch error while leaving the previous workspace hydrated", async () => {
    apiMock.openWorkspace.mockRejectedValueOnce(new AgentRequestError(
      "No se puede abrir el proyecto.",
      403,
      "WORKSPACE_UNREADABLE",
    ));

    await useWorkspaceManagerStore.getState().requestSwitch(targetB);

    expect(workspaceMock.hydrateBootstrap).not.toHaveBeenCalled();
    expect(useWorkspaceManagerStore.getState()).toMatchObject({
      phase: "error",
      pendingTarget: targetB,
      errorCode: "WORKSPACE_UNREADABLE",
      errorMessage: "No se puede abrir el proyecto.",
    });
  });

  it("surfaces a lock conflict and sends an explicit force-release retry", async () => {
    const conflict = {
      conflictId: "85a8118f-a9db-40e9-a32e-9a68b5800bbb",
      lockId: "6422c1c1-5188-461f-98c0-e1a9560ecdb3",
      workspaceId: WORKSPACE_B_ID,
      displayPath: "~/Projects/Proyecto B",
      status: "ambiguous" as const,
      forceAllowed: true,
      pid: 4812,
      agentVersion: "v0.0.5",
      heartbeatAt: "2026-07-25T20:31:30.000Z",
    };
    apiMock.openWorkspace
      .mockRejectedValueOnce(new AgentRequestError(
        "Existe otra sesión asociada al workspace.",
        409,
        "WORKSPACE_LOCK_CONFLICT",
        true,
        "warning",
        conflict,
      ))
      .mockResolvedValueOnce(openResponse(SESSION_B_ID, WORKSPACE_B_ID));

    await useWorkspaceManagerStore.getState().requestSwitch(targetB);

    expect(useWorkspaceManagerStore.getState()).toMatchObject({
      phase: "lockConflict",
      pendingTarget: targetB,
      lockConflict: conflict,
      errorCode: "WORKSPACE_LOCK_CONFLICT",
    });

    await useWorkspaceManagerStore.getState().forceReleaseAndSwitch();

    expect(apiMock.openWorkspace).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedSessionId: SESSION_A_ID,
        target: targetB,
        lockResolution: {
          action: "force-release",
          expectedLockId: conflict.lockId,
          acknowledgeRisk: true,
        },
      }),
    );
    expect(useWorkspaceManagerStore.getState()).toMatchObject({
      phase: "idle",
      pendingTarget: undefined,
      lockConflict: undefined,
    });
  });
});

function createDirtyDraft(
  relativePath: string,
  workspaceId = WORKSPACE_A_ID,
): void {
  getOrCreateEditorDraft(workspaceId, relativePath, {
    content: "const state = 'changed';",
    savedContent: "const state = 'saved';",
    contentHash: "saved-hash",
    language: "typescript",
    loaded: true,
    status: "idle",
  });
}

function session(id: string, workspaceId: string) {
  return {
    id,
    workspaceId,
    activatedAt: "2026-07-25T20:30:00.000Z",
  };
}

function openResponse(sessionId: string, workspaceId: string) {
  return {
    protocolVersion: 1 as const,
    session: session(sessionId, workspaceId),
    bootstrap: bootstrapFor(sessionId, workspaceId),
  };
}

function bootstrapFor(sessionId: string, workspaceId: string) {
  return {
    marker: workspaceId,
    session: session(sessionId, workspaceId),
  };
}

const browseA = {
  protocolVersion: 1 as const,
  path: "/tmp/Proyecto A",
  parentPath: "/tmp",
  entries: [{
    name: "src",
    path: "/tmp/Proyecto A/src",
    symlink: false,
  }],
  truncated: false,
};

const browseB = {
  protocolVersion: 1 as const,
  path: "/tmp/Proyecto B",
  parentPath: "/tmp",
  entries: [{
    name: "packages",
    path: "/tmp/Proyecto B/packages",
    symlink: false,
  }],
  truncated: false,
};

const browseFirstPage = {
  protocolVersion: 1 as const,
  path: "/tmp/Many folders",
  parentPath: "/tmp",
  entries: [{
    name: "alpha",
    path: "/tmp/Many folders/alpha",
    symlink: false,
  }],
  cursor: "signed-page-two",
  truncated: true,
};

const browseSecondPage = {
  protocolVersion: 1 as const,
  path: browseFirstPage.path,
  parentPath: browseFirstPage.parentPath,
  entries: [
    browseFirstPage.entries[0],
    {
      name: "beta",
      path: "/tmp/Many folders/beta",
      symlink: false,
    },
  ],
  truncated: false,
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
