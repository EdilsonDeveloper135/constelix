import type { LlmPublicConfiguration } from "@constelix/contracts";
import { memo, useEffect, useState } from "react";

import { WorkspaceCanvas } from "./components/canvas/WorkspaceCanvas";
import { WorkspaceOnboarding } from "./components/onboarding/WorkspaceOnboarding";
import { CommandPalette } from "./components/shell/CommandPalette";
import { GlobalNotice } from "./components/shell/GlobalNotice";
import { Rail } from "./components/shell/Rail";
import { SettingsModal } from "./components/shell/SettingsModal";
import { Topbar } from "./components/shell/Topbar";
import { WorkspaceSwitcherDialog } from "./components/shell/WorkspaceSwitcherDialog";
import { useAgentBridge } from "./hooks/useAgentBridge";
import { apiClient } from "./lib/api";
import { closeMonacoLspConnections } from "./lib/lsp";
import { useWorkspaceStore } from "./store/useWorkspaceStore";

export const App = memo(function App() {
  useAgentBridge();
  const settingsOpen = useWorkspaceStore((state) => state.settingsOpen);
  const setSettingsOpen = useWorkspaceStore((state) => state.setSettingsOpen);
  const workspaceId = useWorkspaceStore((state) => state.workspaceId);
  const [llmConfiguration, setLlmConfiguration] =
    useState<LlmPublicConfiguration | null>(null);
  const [llmConfigurationLoading, setLlmConfigurationLoading] = useState(
    () => apiClient.hasToken,
  );
  const [llmConfigurationLoadError, setLlmConfigurationLoadError] =
    useState<string | undefined>();
  const [llmConfigurationLoadAttempt, setLlmConfigurationLoadAttempt] =
    useState(0);

  useEffect(() => {
    if (!apiClient.hasToken) {
      setLlmConfigurationLoading(false);
      return;
    }
    let current = true;
    setLlmConfiguration(null);
    setLlmConfigurationLoading(true);
    setLlmConfigurationLoadError(undefined);
    void apiClient.getLlmConfiguration()
      .then((configuration) => {
        if (current) setLlmConfiguration(configuration);
      })
      .catch(() => {
        if (current) {
          setLlmConfigurationLoadError(
            "No se pudo cargar la configuración del agente. Reintenta antes de guardar para no reemplazar valores existentes.",
          );
        }
      })
      .finally(() => {
        if (current) setLlmConfigurationLoading(false);
      });
    return () => {
      current = false;
    };
  }, [llmConfigurationLoadAttempt, workspaceId]);
  useEffect(
    () => () => closeMonacoLspConnections(),
    [workspaceId],
  );
  useEffect(() => {
    const flushLayout = () => useWorkspaceStore.getState().flushLayout();
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flushLayout();
    };
    window.addEventListener("pagehide", flushLayout);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("pagehide", flushLayout);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, []);

  return (
    <div className="app-shell">
      <Topbar />
      <Rail />
      <WorkspaceCanvas />
      <GlobalNotice />
      <WorkspaceOnboarding />
      <CommandPalette />
      <WorkspaceSwitcherDialog />
      <SettingsModal
        open={settingsOpen}
        loading={llmConfigurationLoading}
        loadError={llmConfigurationLoadError}
        {...(llmConfiguration
          ? {
              initialBaseUrl: llmConfiguration.baseUrl,
              initialModel: llmConfiguration.model,
              apiKeyConfigured: llmConfiguration.apiKeyConfigured,
              apiKeySource: llmConfiguration.apiKeySource,
            }
          : {})}
        onClose={() => setSettingsOpen(false)}
        onRetryLoad={() => {
          setLlmConfigurationLoadAttempt((attempt) => attempt + 1);
        }}
        onSave={async (settings) => {
          const configuration = await apiClient.updateLlmConfiguration({
            protocolVersion: 1,
            baseUrl: settings.baseUrl,
            model: settings.model,
            apiKey: settings.apiKey
              ? { action: "replace", value: settings.apiKey }
              : settings.clearApiKey
                ? { action: "clear" }
                : { action: "preserve" },
          });
          setLlmConfiguration(configuration);
        }}
      />
    </div>
  );
});
