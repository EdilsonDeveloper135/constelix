import {
  Bot,
  CircleHelp,
  Code2,
  Eye,
  FileCode2,
  Folder,
  Network,
  Settings2,
  SquareTerminal
} from "lucide-react";
import { memo, type ComponentType } from "react";

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
  { id: "files", label: "Archivos", icon: Folder },
  { id: "diagrams", label: "Diagramas", icon: FileCode2, disabled: true },
  { id: "editor", label: "Editor", icon: Code2 },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "preview", label: "Vista previa", icon: Eye, disabled: true },
  { id: "ai", label: "IA", icon: Bot }
];

export const Rail = memo(function Rail() {
  const activeTool = useWorkspaceStore((state) => state.activeTool);
  const setActiveTool = useWorkspaceStore((state) => state.setActiveTool);
  const setSettingsOpen = useWorkspaceStore((state) => state.setSettingsOpen);

  return (
    <aside className="rail" aria-label="Herramientas del workspace">
      <nav className="rail-nav">
        {tools.map((item) => {
          const Icon = item.icon;
          const selected = activeTool === item.id;
          return (
            <button
              key={item.id}
              className={`rail-item${selected ? " rail-item--active" : ""}`}
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
      </nav>
      <div className="rail-footer">
        <button type="button" aria-label="Configuración" onClick={() => setSettingsOpen(true)}><Settings2 aria-hidden="true" size={19} /></button>
        <button type="button" aria-label="Ayuda"><CircleHelp aria-hidden="true" size={19} /></button>
      </div>
    </aside>
  );
});
