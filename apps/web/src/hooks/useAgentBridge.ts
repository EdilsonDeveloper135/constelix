import { useEffect } from "react";

import { apiClient } from "../lib/api";
import { useWorkspaceStore } from "../store/useWorkspaceStore";

export function useAgentBridge(): void {
  const hydrateBootstrap = useWorkspaceStore((state) => state.hydrateBootstrap);
  const handleAgentEvent = useWorkspaceStore((state) => state.handleAgentEvent);
  const setConnection = useWorkspaceStore((state) => state.setConnection);

  useEffect(() => {
    let active = true;
    const unsubscribe = apiClient.subscribe(handleAgentEvent);
    const disconnect = apiClient.connect();

    if (!apiClient.hasToken) {
      setConnection("degraded");
    } else {
      void apiClient
        .bootstrap()
        .then((payload) => {
          if (active) hydrateBootstrap(payload);
        })
        .catch(() => {
          if (active) setConnection("degraded");
        });
    }

    return () => {
      active = false;
      unsubscribe();
      disconnect();
    };
  }, [handleAgentEvent, hydrateBootstrap, setConnection]);
}
