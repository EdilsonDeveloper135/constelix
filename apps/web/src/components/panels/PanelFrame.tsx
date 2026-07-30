import { Maximize2, Minus, Move, PanelBottom, PanelRight, X } from "lucide-react";
import { memo, type PropsWithChildren } from "react";
import { NodeResizer, useReactFlow } from "@xyflow/react";

import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import type { PanelDock } from "../../types";

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
  docked?: boolean;
  dockTarget: Exclude<PanelDock, "floating">;
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
  docked = false,
  dockTarget,
  children
}: PanelFrameProps) {
  const compactMode = useWorkspaceStore((state) => state.compactMode);
  const closePanel = useWorkspaceStore((state) => state.closePanel);
  const setPanelCollapsed = useWorkspaceStore((state) => state.setPanelCollapsed);
  const setPanelDock = useWorkspaceStore((state) => state.setPanelDock);
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
      className={`tool-panel tool-panel--${accent} ${collapsed ? "tool-panel--collapsed" : ""} ${compactMode && !docked ? "tool-panel--compact" : ""} ${docked ? "tool-panel--docked" : ""} ${className}`}
      aria-label={title}
    >
      {!docked ? (
        <NodeResizer
          minWidth={minWidth}
          minHeight={collapsed ? 42 : minHeight}
          isVisible={!collapsed && !compactMode}
          lineClassName="panel-resizer-line"
          handleClassName="panel-resizer-handle"
          onResizeEnd={saveLayout}
        />
      ) : null}
      <header className={`panel-titlebar${docked ? " panel-titlebar--docked" : ""}`}>
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
          <button
            type="button"
            aria-label={
              docked
                ? "Desanclar panel al canvas"
                : dockTarget === "right"
                  ? "Anclar panel a la derecha"
                  : "Anclar panel abajo"
            }
            aria-pressed={docked}
            onClick={() => {
              setPanelDock(id, docked ? "floating" : dockTarget);
              if (docked) {
                window.requestAnimationFrame(() => {
                  void fitView({
                    nodes: [{ id }],
                    duration: 260,
                    padding: 0.12,
                    maxZoom: 1,
                  });
                });
              }
            }}
          >
            {docked ? (
              <Move aria-hidden="true" size={13} />
            ) : dockTarget === "right" ? (
              <PanelRight aria-hidden="true" size={13} />
            ) : (
              <PanelBottom aria-hidden="true" size={13} />
            )}
          </button>
          {!docked ? (
            <>
              <button
                type="button"
                aria-label={collapsed ? "Restaurar panel" : "Contraer panel"}
                aria-expanded={!collapsed}
                onClick={toggleCollapsed}
              >
                <Minus aria-hidden="true" size={14} />
              </button>
              <button
                type="button"
                aria-label="Enfocar panel"
                onClick={() => void fitView({ nodes: [{ id }], duration: 260, padding: 0.12, maxZoom: 1 })}
              >
                <Maximize2 aria-hidden="true" size={13} />
              </button>
            </>
          ) : null}
          <button type="button" aria-label="Cerrar panel" onClick={() => closePanel(id)}>
            <X aria-hidden="true" size={14} />
          </button>
        </div>
      </header>
      <div className="panel-body nowheel nodrag nopan">
        {compactMode && !docked && !collapsed ? (
          <div className="panel-compact-placeholder" aria-hidden="true">
            Contenido suspendido a este nivel de zoom
          </div>
        ) : children}
      </div>
    </section>
  );
});
