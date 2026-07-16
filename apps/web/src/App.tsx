import { memo } from "react";

import { WorkspaceCanvas } from "./components/canvas/WorkspaceCanvas";
import { CommandPalette } from "./components/shell/CommandPalette";
import { Rail } from "./components/shell/Rail";
import { Topbar } from "./components/shell/Topbar";
import { useAgentBridge } from "./hooks/useAgentBridge";

export const App = memo(function App() {
  useAgentBridge();

  return (
    <div className="app-shell">
      <Topbar />
      <Rail />
      <WorkspaceCanvas />
      <CommandPalette />
    </div>
  );
});
