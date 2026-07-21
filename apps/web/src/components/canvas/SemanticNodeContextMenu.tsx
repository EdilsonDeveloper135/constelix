import {
  Eye,
  ExternalLink,
  FolderOpen,
  SquareTerminal,
} from "lucide-react";
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
} from "react";

import { semanticNodeCapabilities } from "../../lib/semanticNodeActions";
import type { SemanticFlowNode } from "../../types";

const MENU_WIDTH = 232;
const MENU_GUTTER = 8;

export interface ContextMenuPosition {
  x: number;
  y: number;
}

interface SemanticNodeContextMenuProps extends ContextMenuPosition {
  node: SemanticFlowNode;
  returnFocusTo?: HTMLElement | null;
  onClose: () => void;
  onInspect: () => void;
  onActivate: () => void;
  onOpenFile: () => void;
  onOpenTerminal: () => void;
}

interface MenuItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  action: () => void;
}

export const SemanticNodeContextMenu = memo(
  function SemanticNodeContextMenu({
    node,
    x,
    y,
    returnFocusTo,
    onClose,
    onInspect,
    onActivate,
    onOpenFile,
    onOpenTerminal,
  }: SemanticNodeContextMenuProps) {
    const menuRef = useRef<HTMLDivElement>(null);
    const capabilities = semanticNodeCapabilities(node.data);
    const items = useMemo<MenuItem[]>(() => {
      const next: MenuItem[] = [
        {
          id: "inspect",
          label: "Inspeccionar nodo",
          icon: <Eye aria-hidden="true" size={14} />,
          action: onInspect,
        },
      ];
      if (capabilities.canActivate) {
        next.push({
          id: "explore",
          label: node.data.expanded ? "Actualizar relaciones" : "Explorar relaciones",
          icon: <FolderOpen aria-hidden="true" size={14} />,
          action: onActivate,
        });
      }
      if (capabilities.canOpenFile) {
        next.push({
          id: "file",
          label: "Abrir en el editor",
          icon: <ExternalLink aria-hidden="true" size={14} />,
          action: onOpenFile,
        });
      }
      if (capabilities.canOpenTerminal) {
        next.push({
          id: "terminal",
          label: "Abrir terminal aquí",
          icon: <SquareTerminal aria-hidden="true" size={14} />,
          action: onOpenTerminal,
        });
      }
      return next;
    }, [
      capabilities.canActivate,
      capabilities.canOpenFile,
      capabilities.canOpenTerminal,
      node.data.expanded,
      onActivate,
      onInspect,
      onOpenFile,
      onOpenTerminal,
    ]);
    const position = clampContextMenuPosition(
      { x, y },
      { width: window.innerWidth, height: window.innerHeight },
      { width: MENU_WIDTH, height: 42 + items.length * 36 },
    );

    useEffect(() => {
      menuRef.current
        ?.querySelector<HTMLButtonElement>("[role='menuitem']")
        ?.focus();
    }, []);

    const closeAndRestoreFocus = () => {
      onClose();
      window.requestAnimationFrame(() => returnFocusTo?.focus());
    };

    const runItem = (item: MenuItem) => {
      item.action();
      closeAndRestoreFocus();
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeAndRestoreFocus();
        return;
      }
      const menuItems = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? [],
      );
      const currentIndex = menuItems.indexOf(document.activeElement as HTMLButtonElement);
      let nextIndex: number | undefined;
      if (event.key === "Tab") {
        nextIndex = event.shiftKey
          ? (currentIndex <= 0 ? menuItems.length : currentIndex) - 1
          : (Math.max(currentIndex, -1) + 1) % menuItems.length;
      } else if (event.key === "ArrowDown") {
        nextIndex = (Math.max(currentIndex, -1) + 1) % menuItems.length;
      } else if (event.key === "ArrowUp") {
        nextIndex = (currentIndex <= 0 ? menuItems.length : currentIndex) - 1;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = menuItems.length - 1;
      }
      if (nextIndex === undefined || menuItems.length === 0) return;
      event.preventDefault();
      menuItems[nextIndex]?.focus();
    };

    return (
      <div
        className="semantic-context-menu-backdrop"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) closeAndRestoreFocus();
        }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <div
          ref={menuRef}
          className="semantic-context-menu"
          role="menu"
          aria-label={`Acciones para ${node.data.label}`}
          data-testid="semantic-node-context-menu"
          style={{ left: position.x, top: position.y }}
          onKeyDown={handleKeyDown}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="semantic-context-menu__title" aria-hidden="true">
            <strong>{node.data.label}</strong>
            <span>{node.data.kind}</span>
          </div>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onClick={() => runItem(item)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </div>
    );
  },
);

export function clampContextMenuPosition(
  point: ContextMenuPosition,
  viewport: { width: number; height: number },
  menu: { width: number; height: number },
): ContextMenuPosition {
  return {
    x: Math.max(
      MENU_GUTTER,
      Math.min(point.x, viewport.width - menu.width - MENU_GUTTER),
    ),
    y: Math.max(
      MENU_GUTTER,
      Math.min(point.y, viewport.height - menu.height - MENU_GUTTER),
    ),
  };
}
