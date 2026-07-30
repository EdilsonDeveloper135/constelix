import {
  WorkspaceLockConflictSchema,
  type RecentWorkspace,
  type WorkspaceBrowseResponse,
  type WorkspaceLockConflict,
  type WorkspaceTarget,
} from "@constelix/contracts";
import { create } from "zustand";

import { AgentRequestError, apiClient } from "../lib/api";
import {
  clearEditorDraftsForWorkspace,
  listDirtyEditorDrafts,
} from "../lib/editorDrafts";
import { useWorkspaceStore } from "./useWorkspaceStore";

type SwitchPhase =
  | "idle"
  | "loading"
  | "dirtyGuard"
  | "validating"
  | "activating"
  | "lockConflict"
  | "error";

interface WorkspaceManagerState {
  selectorOpen: boolean;
  phase: SwitchPhase;
  recents: RecentWorkspace[];
  pathDraft: string;
  browse: WorkspaceBrowseResponse | null;
  browseLoading: boolean;
  browseShowHidden: boolean;
  errorCode: string | undefined;
  errorMessage: string | undefined;
  pendingTarget: WorkspaceTarget | undefined;
  guardSourceWorkspaceId: string | undefined;
  guardSourceSessionId: string | undefined;
  lockConflict: WorkspaceLockConflict | undefined;
  openSelector(): Promise<void>;
  closeSelector(): void;
  setPathDraft(path: string): void;
  browsePath(path: string, showHidden?: boolean): Promise<void>;
  loadMoreBrowse(): Promise<void>;
  requestSwitch(target: WorkspaceTarget): Promise<void>;
  confirmDirtyDrafts(action: "preserve" | "discard" | "cancel"): Promise<void>;
  forceReleaseAndSwitch(): Promise<void>;
}

let browseEpoch = 0;
let switchEpoch = 0;
let selectorEpoch = 0;

export const useWorkspaceManagerStore = create<WorkspaceManagerState>(
  (set, get) => ({
    selectorOpen: false,
    phase: "idle",
    recents: [],
    pathDraft: "",
    browse: null,
    browseLoading: false,
    browseShowHidden: false,
    errorCode: undefined,
    errorMessage: undefined,
    pendingTarget: undefined,
    guardSourceWorkspaceId: undefined,
    guardSourceSessionId: undefined,
    lockConflict: undefined,

    openSelector: async () => {
      const requestEpoch = ++selectorEpoch;
      set({
        selectorOpen: true,
        phase: "loading",
        errorCode: undefined,
        errorMessage: undefined,
        pendingTarget: undefined,
        guardSourceWorkspaceId: undefined,
        guardSourceSessionId: undefined,
        lockConflict: undefined,
      });
      try {
        const workspaces = await apiClient.listWorkspaces();
        if (
          requestEpoch !== selectorEpoch ||
          !get().selectorOpen ||
          get().phase !== "loading"
        ) {
          return;
        }
        set({
          recents: workspaces.recents,
          phase: "idle",
        });
      } catch (error) {
        if (
          requestEpoch !== selectorEpoch ||
          !get().selectorOpen ||
          get().phase !== "loading"
        ) {
          return;
        }
        set({
          phase: "error",
          errorCode:
            error instanceof AgentRequestError ? error.code : undefined,
          errorMessage: messageOf(
            error,
            "No se pudieron cargar los workspaces recientes.",
          ),
        });
      }
    },

    closeSelector: () => {
      if (isSwitching(get().phase)) return;
      browseEpoch += 1;
      switchEpoch += 1;
      selectorEpoch += 1;
      set({
        selectorOpen: false,
        phase: "idle",
        browseLoading: false,
        pendingTarget: undefined,
        guardSourceWorkspaceId: undefined,
        guardSourceSessionId: undefined,
        lockConflict: undefined,
        errorCode: undefined,
        errorMessage: undefined,
      });
    },

    setPathDraft: (pathDraft) => set({ pathDraft }),

    browsePath: async (path, showHidden = false) => {
      const requestEpoch = ++browseEpoch;
      set((state) => ({
        browseLoading: true,
        ...(state.phase === "error" ? { phase: "idle" as const } : {}),
        errorCode: undefined,
        errorMessage: undefined,
      }));
      try {
        const browse = await apiClient.browseDirectories(path, { showHidden });
        if (requestEpoch !== browseEpoch) return;
        set({
          browse,
          pathDraft: browse.path,
          browseLoading: false,
          browseShowHidden: showHidden,
        });
      } catch (error) {
        if (requestEpoch !== browseEpoch) return;
        set({
          browseLoading: false,
          phase: "error",
          errorCode:
            error instanceof AgentRequestError ? error.code : undefined,
          errorMessage: messageOf(error, "No se pudo explorar esa carpeta."),
        });
      }
    },

    loadMoreBrowse: async () => {
      const state = get();
      const current = state.browse;
      if (
        state.browseLoading ||
        !current?.truncated ||
        !current.cursor
      ) {
        return;
      }
      const requestEpoch = ++browseEpoch;
      set({
        browseLoading: true,
        ...(state.phase === "error" ? { phase: "idle" as const } : {}),
        errorCode: undefined,
        errorMessage: undefined,
      });
      try {
        const page = await apiClient.browseDirectories(current.path, {
          showHidden: state.browseShowHidden,
          cursor: current.cursor,
        });
        if (requestEpoch !== browseEpoch) return;
        const activeBrowse = get().browse;
        if (
          activeBrowse?.path !== current.path ||
          activeBrowse.cursor !== current.cursor
        ) {
          set({ browseLoading: false });
          return;
        }
        if (
          page.path !== current.path ||
          page.parentPath !== current.parentPath ||
          (page.truncated &&
            (!page.cursor || page.cursor === current.cursor))
        ) {
          throw new Error(
            "El agente devolvió una página de carpetas inconsistente.",
          );
        }
        const entriesByPath = new Map(
          current.entries.map((entry) => [entry.path, entry]),
        );
        for (const entry of page.entries) {
          entriesByPath.set(entry.path, entry);
        }
        set({
          browse: {
            ...page,
            entries: [...entriesByPath.values()],
          },
          browseLoading: false,
        });
      } catch (error) {
        if (requestEpoch !== browseEpoch) return;
        set({
          browseLoading: false,
          phase: "error",
          errorCode:
            error instanceof AgentRequestError ? error.code : undefined,
          errorMessage: messageOf(
            error,
            "No se pudo cargar la siguiente página de carpetas.",
          ),
        });
      }
    },

    requestSwitch: async (target) => {
      if (isSwitching(get().phase)) return;
      selectorEpoch += 1;
      const workspace = useWorkspaceStore.getState();
      const sessionId = apiClient.sessionId;
      if (!sessionId) {
        setSessionMissing(set);
        return;
      }
      const origin = {
        workspaceId: workspace.workspaceId,
        sessionId,
      };
      if (hasActiveActTask()) {
        setActTaskBlocked(set);
        return;
      }
      if (listDirtyEditorDrafts(workspace.workspaceId).length > 0) {
        set({
          phase: "dirtyGuard",
          pendingTarget: target,
          guardSourceWorkspaceId: origin.workspaceId,
          guardSourceSessionId: origin.sessionId,
        });
        return;
      }
      await performSwitch(target, false, set, origin);
    },

    confirmDirtyDrafts: async (action) => {
      const state = get();
      const target = state.pendingTarget;
      if (!target || action === "cancel") {
        clearSwitchGuard(set);
        return;
      }
      const origin = switchOriginFromState(state);
      if (!origin || !isCurrentSwitchOrigin(origin)) {
        setStaleSwitchGuard(set);
        return;
      }
      if (hasActiveActTask()) {
        setActTaskBlocked(set);
        return;
      }
      await performSwitch(target, action === "discard", set, origin);
    },

    forceReleaseAndSwitch: async () => {
      const state = get();
      const target = state.pendingTarget;
      const conflict = state.lockConflict;
      if (!target || !conflict?.forceAllowed) return;
      const origin = switchOriginFromState(state);
      if (!origin || !isCurrentSwitchOrigin(origin)) {
        setStaleSwitchGuard(set);
        return;
      }
      if (hasActiveActTask()) {
        setActTaskBlocked(set);
        return;
      }
      await performSwitch(target, false, set, origin, {
        action: "force-release",
        expectedLockId: conflict.lockId,
        acknowledgeRisk: true,
      });
    },
  }),
);

async function performSwitch(
  target: WorkspaceTarget,
  discardDrafts: boolean,
  set: (
    partial:
      | Partial<WorkspaceManagerState>
      | ((
          state: WorkspaceManagerState,
        ) => Partial<WorkspaceManagerState>),
  ) => void,
  origin: SwitchOrigin,
  lockResolution?: {
    action: "force-release";
    expectedLockId: string;
    acknowledgeRisk: true;
  },
): Promise<void> {
  const requestEpoch = ++switchEpoch;
  browseEpoch += 1;
  const workspace = useWorkspaceStore.getState();
  if (!isCurrentSwitchOrigin(origin)) {
    setStaleSwitchGuard(set);
    return;
  }
  if (hasActiveActTask()) {
    setActTaskBlocked(set);
    return;
  }

  set({
    phase: "validating",
    browseLoading: false,
    pendingTarget: target,
    guardSourceWorkspaceId: origin.workspaceId,
    guardSourceSessionId: origin.sessionId,
    lockConflict: undefined,
    errorCode: undefined,
    errorMessage: undefined,
  });
  try {
    await workspace.saveLayoutNow();
    if (requestEpoch !== switchEpoch) return;
    if (!isCurrentSwitchOrigin(origin)) {
      setStaleSwitchGuard(set);
      return;
    }
    if (hasActiveActTask()) {
      setActTaskBlocked(set);
      return;
    }
    useWorkspaceStore.getState().cancelQuestion();
    if (discardDrafts) {
      clearEditorDraftsForWorkspace(origin.workspaceId);
    }

    set({ phase: "activating" });
    const opened = await apiClient.openWorkspace({
      protocolVersion: 1,
      requestId: crypto.randomUUID(),
      expectedSessionId: origin.sessionId,
      target,
      ...(lockResolution ? { lockResolution } : {}),
    });
    if (requestEpoch !== switchEpoch) {
      void useWorkspaceStore.getState().reconcileGraph();
      return;
    }
    useWorkspaceStore.getState().hydrateBootstrap(opened.bootstrap);
    set({
      selectorOpen: false,
      phase: "idle",
      pendingTarget: undefined,
      guardSourceWorkspaceId: undefined,
      guardSourceSessionId: undefined,
      lockConflict: undefined,
      errorCode: undefined,
      errorMessage: undefined,
    });
  } catch (error) {
    if (requestEpoch !== switchEpoch) return;
    if (isTransitionRaceError(error)) {
      await useWorkspaceStore.getState().reconcileGraph();
      if (requestEpoch !== switchEpoch) return;
      const reconciled = useWorkspaceStore.getState();
      if (
        reconciled.remoteHydrated &&
        apiClient.sessionId !== null &&
        apiClient.sessionId !== origin.sessionId
      ) {
        set({
          selectorOpen: false,
          phase: "idle",
          pendingTarget: undefined,
          guardSourceWorkspaceId: undefined,
          guardSourceSessionId: undefined,
          lockConflict: undefined,
          errorCode: undefined,
          errorMessage: undefined,
        });
        return;
      }
      set({
        phase: "error",
        pendingTarget: undefined,
        guardSourceWorkspaceId: undefined,
        guardSourceSessionId: undefined,
        lockConflict: undefined,
        errorCode: "WORKSPACE_RECONCILIATION_FAILED",
        errorMessage:
          "El workspace cambió, pero Constelix no pudo reconciliar la sesión activa.",
      });
      return;
    }
    const agentError =
      error instanceof AgentRequestError ? error : undefined;
    const parsedConflict =
      agentError
        ? WorkspaceLockConflictSchema.safeParse(agentError.details)
        : undefined;
    if (parsedConflict?.success) {
      set({
        phase: "lockConflict",
        lockConflict: parsedConflict.data,
        pendingTarget: target,
        guardSourceWorkspaceId: origin.workspaceId,
        guardSourceSessionId: origin.sessionId,
        errorCode: agentError?.code,
        errorMessage: agentError?.message,
      });
      return;
    }
    set({
      phase: "error",
      pendingTarget: target,
      guardSourceWorkspaceId: undefined,
      guardSourceSessionId: undefined,
      errorCode:
        error instanceof AgentRequestError ? error.code : undefined,
      errorMessage: messageOf(
        error,
        "Constelix no pudo cambiar de workspace. El workspace anterior sigue activo.",
      ),
    });
  }
}

interface SwitchOrigin {
  workspaceId: string;
  sessionId: string;
}

function switchOriginFromState(
  state: WorkspaceManagerState,
): SwitchOrigin | undefined {
  return state.guardSourceWorkspaceId && state.guardSourceSessionId
    ? {
        workspaceId: state.guardSourceWorkspaceId,
        sessionId: state.guardSourceSessionId,
      }
    : undefined;
}

function isCurrentSwitchOrigin(origin: SwitchOrigin): boolean {
  const workspace = useWorkspaceStore.getState();
  return (
    workspace.workspaceId === origin.workspaceId &&
    apiClient.sessionId === origin.sessionId &&
    !apiClient.workspaceTransitioning
  );
}

function hasActiveActTask(): boolean {
  const status = useWorkspaceStore.getState().actTask?.status;
  return status === "running" || status === "cancelling";
}

function clearSwitchGuard(
  set: (partial: Partial<WorkspaceManagerState>) => void,
): void {
  set({
    phase: "idle",
    pendingTarget: undefined,
    guardSourceWorkspaceId: undefined,
    guardSourceSessionId: undefined,
    lockConflict: undefined,
    errorCode: undefined,
    errorMessage: undefined,
  });
}

function setSessionMissing(
  set: (partial: Partial<WorkspaceManagerState>) => void,
): void {
  set({
    phase: "error",
    pendingTarget: undefined,
    guardSourceWorkspaceId: undefined,
    guardSourceSessionId: undefined,
    errorCode: "WORKSPACE_SESSION_MISSING",
    errorMessage: "La sesión local todavía no está lista.",
  });
}

function setActTaskBlocked(
  set: (partial: Partial<WorkspaceManagerState>) => void,
): void {
  set({
    phase: "error",
    pendingTarget: undefined,
    guardSourceWorkspaceId: undefined,
    guardSourceSessionId: undefined,
    lockConflict: undefined,
    errorCode: "ACT_TASK_RUNNING",
    errorMessage:
      "Cancela o completa la tarea de Actuar antes de cambiar de workspace.",
  });
}

function setStaleSwitchGuard(
  set: (partial: Partial<WorkspaceManagerState>) => void,
): void {
  set({
    phase: "error",
    pendingTarget: undefined,
    guardSourceWorkspaceId: undefined,
    guardSourceSessionId: undefined,
    lockConflict: undefined,
    errorCode: "WORKSPACE_GUARD_STALE",
    errorMessage:
      "El workspace activo cambió. Reabre el selector antes de confirmar esta acción.",
  });
}

function isTransitionRaceError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof AgentRequestError &&
      (error.code === "WORKSPACE_TRANSITION_PENDING" ||
        error.code === "WORKSPACE_SESSION_CHANGED"))
  );
}

function isSwitching(phase: SwitchPhase): boolean {
  return phase === "validating" || phase === "activating";
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}
