import {
  Bot,
  ChevronDown,
  Command,
  Eye,
  Pencil,
  Search,
  Settings2,
  Sparkles,
  SquareTerminal,
  Wifi,
  WifiOff,
} from "lucide-react";
import { memo } from "react";

import {
  askModeLabel,
  connectionLabel,
  workspaceModeLabel,
} from "../../lib/workspacePresentation";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import { useWorkspaceManagerStore } from "../../store/useWorkspaceManagerStore";

export const Topbar = memo(function Topbar() {
  const workspaceName = useWorkspaceStore((state) => state.workspaceName);
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const workspaceMode = useWorkspaceStore((state) => state.workspaceMode);
  const askMode = useWorkspaceStore((state) => state.askMode);
  const askNotice = useWorkspaceStore((state) => state.askNotice);
  const actAvailable = useWorkspaceStore((state) => state.actAvailable);
  const codexChecking = useWorkspaceStore((state) => state.codexChecking);
  const codexReason = useWorkspaceStore((state) => state.codexReason);
  const connection = useWorkspaceStore((state) => state.connection);
  const demoMode = useWorkspaceStore((state) => state.demoMode);
  const setCommandPaletteOpen = useWorkspaceStore((state) => state.setCommandPaletteOpen);
  const setSettingsOpen = useWorkspaceStore((state) => state.setSettingsOpen);
  const selectorOpen = useWorkspaceManagerStore((state) => state.selectorOpen);
  const openWorkspaceSelector = useWorkspaceManagerStore(
    (state) => state.openSelector,
  );

  const connected = connection === "connected";

  return (
    <header className="topbar">
      <div className="brand" aria-label="Constelix">
        <Sparkles aria-hidden="true" size={19} strokeWidth={1.8} />
        <span>Constelix</span>
      </div>
      <div className="topbar-divider" />
      <button
        className="workspace-identity workspace-identity--trigger"
        type="button"
        title={rootPath}
        aria-label={`Cambiar workspace. Actual: ${workspaceName}`}
        aria-haspopup="dialog"
        aria-expanded={selectorOpen}
        data-workspace-trigger
        onClick={() => void openWorkspaceSelector()}
      >
        <span>
          <strong>{workspaceName}</strong>
          <small>{rootPath}</small>
        </span>
        <ChevronDown aria-hidden="true" size={13} />
      </button>
      <div className="topbar-divider topbar-divider--compact" />
      <div className={`connection-status connection-status--${connection}`} role="status">
        {connected ? <Wifi aria-hidden="true" size={13} /> : <WifiOff aria-hidden="true" size={13} />}
        <span>{connectionLabel(connection, demoMode)}</span>
      </div>
      <div className="topbar-status-chips" aria-label="Modos del workspace">
        <span className={`status-chip status-chip--${workspaceMode}`}>
          {workspaceMode === "read" ? (
            <Eye aria-hidden="true" size={11} />
          ) : (
            <Pencil aria-hidden="true" size={11} />
          )}
          {workspaceModeLabel(workspaceMode)}
        </span>
        <span
          className={`status-chip status-chip--ask-${askMode}`}
          title={askNotice}
        >
          <Bot aria-hidden="true" size={11} />
          {askModeLabel(askMode)}
        </span>
        <span
          className={`status-chip status-chip--codex-${actAvailable ? "ready" : "unavailable"}`}
          title={codexReason}
        >
          <SquareTerminal aria-hidden="true" size={11} />
          {codexChecking
            ? "Codex…"
            : actAvailable
              ? "Codex listo"
              : workspaceMode === "read"
                ? "Act bloqueado"
                : "Codex no disponible"}
        </span>
      </div>

      <button className="command-trigger" type="button" onClick={() => setCommandPaletteOpen(true)}>
        <Search aria-hidden="true" size={15} />
        <span>Buscar o ejecutar comando…</span>
        <kbd><Command aria-hidden="true" size={11} /> K</kbd>
      </button>
      <button className="topbar-icon-button" type="button" aria-label="Configuración" onClick={() => setSettingsOpen(true)}>
        <Settings2 aria-hidden="true" size={17} />
      </button>
    </header>
  );
});
