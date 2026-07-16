import { Maximize2, Minus, X } from "lucide-react";
import { memo, type PropsWithChildren } from "react";
import { NodeResizer, useReactFlow } from "@xyflow/react";

import { useWorkspaceStore } from "../../store/useWorkspaceStore";

interface PanelFrameProps extends PropsWithChildren {
  id: string;
  title: string;
  icon: React.ReactNode;
  minWidth: number;
  minHeight: number;
  currentHeight?: number | undefined;
  collapsed?: boolean | undefined;
  expandedHeight?: number | undefined;
  accent?: "cyan" | "green" | "violet";
  className?: string;
  actions?: React.ReactNode;
}

export const PanelFrame = memo(function PanelFrame({
  id,
  title,
  icon,
  minWidth,
  minHeight,
  currentHeight = minHeight,
  collapsed = false,
  expandedHeight = currentHeight,
  accent = "cyan",
  className = "",
  actions,
  children
}: PanelFrameProps) {
  const compactMode = useWorkspaceStore((state) => state.compactMode);
  const closePanel = useWorkspaceStore((state) => state.closePanel);
  const setPanelCollapsed = useWorkspaceStore((state) => state.setPanelCollapsed);
  const saveLayout = useWorkspaceStore((state) => state.saveLayout);
  const { fitView } = useReactFlow();

  const toggleCollapsed = () => {
    const rememberedHeight = collapsed
      ? Math.max(expandedHeight, minHeight)
      : currentHeight > 60
        ? currentHeight
        : Math.max(expandedHeight, minHeight);
    setPanelCollapsed(id, !collapsed, rememberedHeight);
  };

  return (
    <section
      className={`tool-panel tool-panel--${accent} ${collapsed ? "tool-panel--collapsed" : ""} ${compactMode ? "tool-panel--compact" : ""} ${className}`}
      aria-label={title}
    >
      <NodeResizer
        minWidth={minWidth}
        minHeight={collapsed ? 42 : minHeight}
        isVisible={!collapsed && !compactMode}
        lineClassName="panel-resizer-line"
        handleClassName="panel-resizer-handle"
        onResizeEnd={saveLayout}
      />
      <header className="panel-titlebar">
        <div className="panel-title">
          {icon}
          <span>{title}</span>
        </div>
        <div
          className="panel-title-actions nodrag"
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {actions}
          <button type="button" aria-label={collapsed ? "Restaurar panel" : "Contraer panel"} onClick={toggleCollapsed}>
            <Minus aria-hidden="true" size={14} />
          </button>
          <button
            type="button"
            aria-label="Enfocar panel"
            onClick={() => void fitView({ nodes: [{ id }], duration: 260, padding: 0.12, maxZoom: 1 })}
          >
            <Maximize2 aria-hidden="true" size={13} />
          </button>
          <button type="button" aria-label="Cerrar panel" onClick={() => closePanel(id)}>
            <X aria-hidden="true" size={14} />
          </button>
        </div>
      </header>
      <div className="panel-body nowheel nodrag nopan">
        {compactMode && !collapsed ? (
          <div className="panel-compact-placeholder" aria-hidden="true">
            Contenido suspendido a este nivel de zoom
          </div>
        ) : children}
      </div>
    </section>
  );
});
