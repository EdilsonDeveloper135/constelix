import { ChevronDown, Command, GitBranch, Search, Settings2, Sparkles, Wifi, WifiOff } from "lucide-react";
import { memo } from "react";

import { useWorkspaceStore } from "../../store/useWorkspaceStore";

export const Topbar = memo(function Topbar() {
  const workspaceName = useWorkspaceStore((state) => state.workspaceName);
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const branch = useWorkspaceStore((state) => state.branch);
  const connection = useWorkspaceStore((state) => state.connection);
  const setCommandPaletteOpen = useWorkspaceStore((state) => state.setCommandPaletteOpen);

  const connected = connection === "connected";

  return (
    <header className="topbar">
      <div className="brand" aria-label="Constelix">
        <Sparkles aria-hidden="true" size={19} strokeWidth={1.8} />
        <span>Constelix</span>
      </div>
      <div className="topbar-divider" />
      <div className="workspace-identity" title={rootPath}>
        <strong>{workspaceName}</strong>
        <span>{rootPath}</span>
      </div>
      <div className="topbar-divider topbar-divider--compact" />
      <button className="branch-button" type="button" aria-label={`Rama ${branch}`}>
        <GitBranch aria-hidden="true" size={14} />
        <span>{branch}</span>
        <ChevronDown aria-hidden="true" size={13} />
      </button>
      <div className="topbar-divider topbar-divider--compact" />
      <div className={`connection-status connection-status--${connection}`} role="status">
        {connected ? <Wifi aria-hidden="true" size={13} /> : <WifiOff aria-hidden="true" size={13} />}
        <span>{connected ? "Local · Conectado" : connection === "connecting" ? "Conectando…" : "Modo demostración"}</span>
      </div>

      <button className="command-trigger" type="button" onClick={() => setCommandPaletteOpen(true)}>
        <Search aria-hidden="true" size={15} />
        <span>Buscar o ejecutar comando…</span>
        <kbd><Command aria-hidden="true" size={11} /> K</kbd>
      </button>
      <button className="topbar-icon-button" type="button" aria-label="Configuración">
        <Settings2 aria-hidden="true" size={17} />
      </button>
    </header>
  );
});
