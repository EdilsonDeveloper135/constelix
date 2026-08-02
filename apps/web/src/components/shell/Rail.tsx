import {
  Bot,
  CircleHelp,
  Code2,
  Network,
  Settings2,
  SquareTerminal
} from "lucide-react";
import { memo, type ComponentType } from "react";

import { useShellStore } from "../../store/useShellStore";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import type { RailTool } from "../../types";

interface RailItem {
  id: RailTool;
  label: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  disabled?: boolean;
}

const tools: RailItem[] = [
  { id: "map", label: "Mapa", icon: Network },
  { id: "files", label: "Código", icon: Code2 },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "ai", label: "Preguntar", icon: Bot }
];

export const Rail = memo(function Rail() {
  const activeTool = useWorkspaceStore((state) => state.activeTool);
  const setActiveTool = useWorkspaceStore((state) => state.setActiveTool);
  const setSettingsOpen = useShellStore((state) => state.setSettingsOpen);
  const setHelpOpen = useShellStore((state) => state.setHelpOpen);

  return (
    <aside className="rail" aria-label="Herramientas del workspace">
      <nav className="rail-nav">
        {tools.map((item) => {
          const Icon = item.icon;
          const selected = activeTool === item.id;
          return (
            <button
              key={item.id}
              className={`rail-item with-tooltip${selected ? " rail-item--active" : ""}`}
              data-tooltip={item.disabled ? `${item.label} (Próximamente)` : item.label}
              type="button"
              aria-current={selected ? "page" : undefined}
              aria-label={item.disabled ? `${item.label}, disponible próximamente` : item.label}
              disabled={item.disabled}
              onClick={() => setActiveTool(item.id)}
            >
              <Icon aria-hidden={true} size={20} />
              <span>{item.label}</span>
            </button>
          );
        })}
        <button
          className="rail-item with-tooltip"
          data-tooltip="Ayuda"
          type="button"
          aria-label="Abrir ayuda y primeros pasos"
          onClick={() => setHelpOpen(true)}
        >
          <CircleHelp aria-hidden={true} size={20} />
          <span>Ayuda</span>
        </button>
      </nav>
      <div className="rail-footer">
        <button
          type="button"
          className="with-tooltip"
          data-tooltip="Configuración"
          aria-label="Configuración"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings2 aria-hidden="true" size={19} />
        </button>
      </div>
    </aside>
  );
});
