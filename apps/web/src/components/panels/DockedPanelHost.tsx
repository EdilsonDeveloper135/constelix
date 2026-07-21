import { memo, useMemo, type KeyboardEvent } from "react";
import { useShallow } from "zustand/react/shallow";

import { nextHorizontalTabIndex } from "../../lib/keyboardNavigation";
import { isDockedToolPanel } from "../../lib/panelDock";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import type {
  AssistantFlowNode,
  EditorFlowNode,
  PanelDock,
  TerminalFlowNode,
  WorkspaceNode,
} from "../../types";
import { AssistantPanel } from "./AssistantPanel";
import { EditorPanel } from "./EditorPanel";
import { TerminalPanel } from "./TerminalPanel";

type DockedPanel = EditorFlowNode | TerminalFlowNode | AssistantFlowNode;
type DockEdge = Exclude<PanelDock, "floating">;

interface DockRegionProps {
  edge: DockEdge;
  panels: DockedPanel[];
  activePanel: DockedPanel;
  onActivate: (id: string) => void;
}

export const DockedPanelHost = memo(function DockedPanelHost() {
  const panels = useWorkspaceStore(
    useShallow((state) =>
      state.nodes.filter(
        (node): node is DockedPanel => isDockedToolPanel(node),
      ),
    ),
  );
  const raisePanel = useWorkspaceStore((state) => state.raisePanel);
  const rightPanels = useMemo(
    () => panels.filter((panel) => panel.data.dock === "right"),
    [panels],
  );
  const bottomPanels = useMemo(
    () => panels.filter((panel) => panel.data.dock === "bottom"),
    [panels],
  );
  const activeRight = activePanel(rightPanels);
  const activeBottom = activePanel(bottomPanels);

  return (
    <>
      {activeRight ? (
        <DockRegion
          edge="right"
          panels={rightPanels}
          activePanel={activeRight}
          onActivate={raisePanel}
        />
      ) : null}
      {activeBottom ? (
        <DockRegion
          edge="bottom"
          panels={bottomPanels}
          activePanel={activeBottom}
          onActivate={raisePanel}
        />
      ) : null}
    </>
  );
});

const DockRegion = memo(function DockRegion({
  edge,
  panels,
  activePanel: selectedPanel,
  onActivate,
}: DockRegionProps) {
  const activeIndex = panels.findIndex((panel) => panel.id === selectedPanel.id);

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const nextIndex = nextHorizontalTabIndex(
      activeIndex,
      event.key,
      panels.length,
    );
    if (nextIndex === null) return;
    event.preventDefault();
    const nextPanel = panels[nextIndex];
    if (!nextPanel) return;
    onActivate(nextPanel.id);
    window.requestAnimationFrame(() => {
      document.getElementById(dockTabId(nextPanel.id))?.focus();
    });
  };

  return (
    <aside
      className={`workspace-dock workspace-dock--${edge}`}
      aria-label={edge === "right" ? "Paneles anclados a la derecha" : "Paneles anclados abajo"}
      data-testid={`workspace-dock-${edge}`}
    >
      <div className="dock-tabs" role="tablist" aria-label="Paneles anclados">
        {panels.map((panel) => {
          const selected = panel.id === selectedPanel.id;
          return (
            <button
              key={panel.id}
              id={dockTabId(panel.id)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={dockPanelId(panel.id)}
              tabIndex={selected ? 0 : -1}
              onClick={() => onActivate(panel.id)}
              onKeyDown={handleTabKeyDown}
            >
              {panelLabel(panel)}
            </button>
          );
        })}
      </div>
      {panels.map((panel) => {
        const selected = panel.id === selectedPanel.id;
        return (
          <div
            key={panel.id}
            id={dockPanelId(panel.id)}
            className={`dock-panel${selected ? "" : " dock-panel--inactive"}`}
            role="tabpanel"
            aria-labelledby={dockTabId(panel.id)}
            aria-hidden={selected ? undefined : true}
            inert={!selected}
          >
            <DockedPanelView panel={panel} />
          </div>
        );
      })}
    </aside>
  );
});

const DockedPanelView = memo(function DockedPanelView({
  panel,
}: {
  panel: DockedPanel;
}) {
  const height = panelHeight(panel);
  if (panel.type === "editorPanel") {
    return <EditorPanel id={panel.id} data={panel.data} height={height} docked />;
  }
  if (panel.type === "terminalPanel") {
    return <TerminalPanel id={panel.id} data={panel.data} height={height} docked />;
  }
  return <AssistantPanel id={panel.id} data={panel.data} height={height} docked />;
});

function activePanel(panels: DockedPanel[]): DockedPanel | undefined {
  let active: DockedPanel | undefined;
  for (const panel of panels) {
    if (!active || (panel.zIndex ?? 0) > (active.zIndex ?? 0)) active = panel;
  }
  return active;
}

function panelHeight(panel: DockedPanel): number {
  if (panel.measured?.height) return panel.measured.height;
  return typeof panel.style?.height === "number" ? panel.style.height : 300;
}

function panelLabel(panel: DockedPanel): string {
  if (panel.type === "editorPanel") return "Editor";
  if (panel.type === "terminalPanel") {
    return panel.id === "panel-terminal" ? "Terminal" : panel.data.title;
  }
  return "Asistente";
}

function dockTabId(id: string): string {
  return `dock-tab-${id}`;
}

function dockPanelId(id: string): string {
  return `dock-panel-${id}`;
}

export function dockedPanelsForEdge(
  nodes: readonly WorkspaceNode[],
  edge: DockEdge,
): DockedPanel[] {
  return nodes.filter(
    (node): node is DockedPanel =>
      isDockedToolPanel(node, edge),
  );
}
