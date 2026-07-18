import { memo, useEffect } from "react";

import { WorkspaceCanvas } from "./components/canvas/WorkspaceCanvas";
import { WorkspaceOnboarding } from "./components/onboarding/WorkspaceOnboarding";
import { CommandPalette } from "./components/shell/CommandPalette";
import { GlobalNotice } from "./components/shell/GlobalNotice";
import { Rail } from "./components/shell/Rail";
import { Topbar } from "./components/shell/Topbar";
import { useAgentBridge } from "./hooks/useAgentBridge";
import { useWorkspaceStore } from "./store/useWorkspaceStore";

export const App = memo(function App() {
  useAgentBridge();
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
    </div>
  );
});
