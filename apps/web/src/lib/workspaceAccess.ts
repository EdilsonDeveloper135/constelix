import type { ConnectionState } from "../types";

interface WorkspaceAccessState {
  demoMode: boolean;
  remoteHydrated: boolean;
  connection: ConnectionState;
}

export function canUseWorkspaceFeatures(
  state: WorkspaceAccessState,
): boolean {
  return (
    state.demoMode ||
    (state.remoteHydrated && state.connection === "connected")
  );
}
