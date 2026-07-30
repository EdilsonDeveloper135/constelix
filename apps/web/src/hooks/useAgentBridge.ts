import { useEffect } from "react";

import { apiClient } from "../lib/api";
import { useWorkspaceStore } from "../store/useWorkspaceStore";

export function useAgentBridge(): void {
  const handleAgentEvent = useWorkspaceStore((state) => state.handleAgentEvent);
  const setConnection = useWorkspaceStore((state) => state.setConnection);

  useEffect(() => {
    const unsubscribe = apiClient.subscribe(handleAgentEvent);
    const unsubscribeConnection = apiClient.subscribeConnection((state) => {
      if (state === "connected") {
        setConnection(
          useWorkspaceStore.getState().remoteHydrated
            ? "connected"
            : "connecting",
        );
      } else if (state === "connecting") {
        setConnection("connecting");
      } else {
        setConnection("degraded");
      }
    });
    const unsubscribeReconciliation =
      apiClient.subscribeWorkspaceReconciliation(() => {
        void useWorkspaceStore.getState().reconcileGraph();
      });
    const disconnect = apiClient.connect();

    if (!apiClient.hasToken) {
      setConnection("degraded");
    }

    return () => {
      unsubscribe();
      unsubscribeConnection();
      unsubscribeReconciliation();
      disconnect();
    };
  }, [handleAgentEvent, setConnection]);
}
