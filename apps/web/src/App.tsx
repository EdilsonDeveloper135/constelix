import type {
  LlmConfigurationUpdate,
  LlmPublicConfiguration,
} from "@constelix/contracts";
import { memo, useEffect, useRef, useState } from "react";

import { WorkspaceCanvas } from "./components/canvas/WorkspaceCanvas";
import { WorkspaceOnboarding } from "./components/onboarding/WorkspaceOnboarding";
import { CommandPalette } from "./components/shell/CommandPalette";
import { GlobalNotice } from "./components/shell/GlobalNotice";
import { HelpCenter } from "./components/shell/HelpCenter";
import { Rail } from "./components/shell/Rail";
import {
  SettingsModal,
  type LlmSettingsDraft,
} from "./components/shell/SettingsModal";
import { Topbar } from "./components/shell/Topbar";
import { WorkspaceSwitcherDialog } from "./components/shell/WorkspaceSwitcherDialog";
import { useAgentBridge } from "./hooks/useAgentBridge";
import { useAppearance } from "./hooks/useAppearance";
import { apiClient } from "./lib/api";
import { closeMonacoLspConnections } from "./lib/lsp";
import { useShellStore } from "./store/useShellStore";
import { useWorkspaceStore } from "./store/useWorkspaceStore";

function toLlmConfigurationUpdate(
  settings: LlmSettingsDraft,
): LlmConfigurationUpdate {
  return {
    protocolVersion: 1,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey
      ? { action: "replace", value: settings.apiKey }
      : settings.clearApiKey
        ? { action: "clear" }
        : { action: "preserve" },
  };
}

export const App = memo(function App() {
  useAgentBridge();
  useAppearance();
  const settingsOpen = useShellStore((state) => state.settingsOpen);
  const setSettingsOpen = useShellStore((state) => state.setSettingsOpen);
  const setOnboardingOpen = useShellStore(
    (state) => state.setOnboardingOpen,
  );
  const workspaceId = useWorkspaceStore((state) => state.workspaceId);
  const demoMode = useWorkspaceStore((state) => state.demoMode);
  const activeTool = useWorkspaceStore((state) => state.activeTool);
  const previousWorkspaceIdRef = useRef(workspaceId);
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
    if (
      workspaceId &&
      workspaceId !== previousWorkspaceIdRef.current &&
      !demoMode
    ) {
      setOnboardingOpen(true);
    }
    previousWorkspaceIdRef.current = workspaceId;
  }, [demoMode, setOnboardingOpen, workspaceId]);
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

  const persistLlmConfiguration = async (settings: LlmSettingsDraft) => {
    const configuration = await apiClient.updateLlmConfiguration(
      toLlmConfigurationUpdate(settings),
    );
    setLlmConfiguration(configuration);
  };

  return (
    <div className="app-shell" data-active-tool={activeTool}>
      <Topbar />
      <Rail />
      <WorkspaceCanvas />
      <GlobalNotice />
      <WorkspaceOnboarding />
      <CommandPalette />
      <HelpCenter />
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
        onSave={persistLlmConfiguration}
        onTest={(settings) =>
          apiClient.testLlmConnection(toLlmConfigurationUpdate(settings))
        }
      />
    </div>
  );
});
