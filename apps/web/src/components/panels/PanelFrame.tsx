import { Maximize2, Minus, X } from "lucide-react";
import { memo, type PropsWithChildren, useRef, useState } from "react";
import { NodeResizer, useReactFlow } from "@xyflow/react";

import { useWorkspaceStore } from "../../store/useWorkspaceStore";

interface PanelFrameProps extends PropsWithChildren {
  id: string;
  title: string;
  icon: React.ReactNode;
  minWidth: number;
  minHeight: number;
  currentHeight?: number | undefined;
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
  accent = "cyan",
  className = "",
  actions,
  children
}: PanelFrameProps) {
  const togglePanel = useWorkspaceStore((state) => state.togglePanel);
  const saveLayout = useWorkspaceStore((state) => state.saveLayout);
  const { fitView, updateNode } = useReactFlow();
  const [collapsed, setCollapsed] = useState(false);
  const expandedHeight = useRef(currentHeight);

  const toggleCollapsed = () => {
    if (!collapsed) expandedHeight.current = currentHeight > 60 ? currentHeight : minHeight;
    const next = !collapsed;
    setCollapsed(next);
    updateNode(id, (node) => ({
      style: { ...node.style, height: next ? 42 : expandedHeight.current }
    }));
    window.setTimeout(saveLayout, 0);
  };

  return (
    <section className={`tool-panel tool-panel--${accent} ${collapsed ? "tool-panel--collapsed" : ""} ${className}`} aria-label={title}>
      <NodeResizer
        minWidth={minWidth}
        minHeight={collapsed ? 42 : minHeight}
        isVisible={!collapsed}
        lineClassName="panel-resizer-line"
        handleClassName="panel-resizer-handle"
        onResizeEnd={saveLayout}
      />
      <header className="panel-titlebar">
        <div className="panel-title">
          {icon}
          <span>{title}</span>
        </div>
        <div className="panel-title-actions nodrag">
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
          <button type="button" aria-label="Cerrar panel" onClick={() => togglePanel(id, false)}>
            <X aria-hidden="true" size={14} />
          </button>
        </div>
      </header>
      <div className="panel-body nowheel nodrag nopan">{children}</div>
    </section>
  );
});
