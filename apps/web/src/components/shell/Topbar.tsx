import {
  Bot,
  ChevronDown,
  Command,
  Search,
  Settings2,
  Sparkles,
  Wifi,
  WifiOff,
} from "lucide-react";
import { memo } from "react";

import {
  askModeLabel,
  connectionLabel,
  workspaceModeLabel,
} from "../../lib/workspacePresentation";
import { useShellStore } from "../../store/useShellStore";
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
  const setCommandPaletteOpen = useShellStore(
    (state) => state.setCommandPaletteOpen,
  );
  const setSettingsOpen = useShellStore((state) => state.setSettingsOpen);
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
      <button
        className={`capability-summary capability-summary--${connection}`}
        data-testid="capability-summary"
        type="button"
        title={[askNotice, codexReason].filter(Boolean).join(" · ")}
        aria-label={`Estado del workspace: ${connectionLabel(connection, demoMode)}. ${askModeLabel(askMode)}. Abrir configuración`}
        onClick={() => setSettingsOpen(true)}
      >
        <span className="capability-summary__icon">
          {connected ? <Wifi aria-hidden="true" size={14} /> : <WifiOff aria-hidden="true" size={14} />}
        </span>
        <span>
          <strong>{connectionLabel(connection, demoMode)}</strong>
          <small>
            <Bot aria-hidden="true" size={11} />
            <span>{workspaceModeLabel(workspaceMode)}</span>
            <i aria-hidden="true">·</i>
            <span>{askModeLabel(askMode)}</span>
            <i aria-hidden="true">·</i>
            <span>{codexChecking ? "Comprobando Codex" : actAvailable ? "Codex listo" : workspaceMode === "read" ? "Actuar bloqueado" : "Codex sin configurar"}</span>
          </small>
        </span>
      </button>

      <button
        className="command-trigger"
        type="button"
        aria-label="Buscar o ejecutar comando"
        title="Buscar o ejecutar comando (⌘K)"
        onClick={() => setCommandPaletteOpen(true)}
      >
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
