import {
  Bot,
  CircleHelp,
  Code2,
  FilterX,
  Focus,
  FolderOpen,
  Network,
  PanelTopClose,
  Search,
  Settings2,
  Sparkles,
  SquareTerminal,
  X,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { useShellStore } from "../../store/useShellStore";
import { useWorkspaceManagerStore } from "../../store/useWorkspaceManagerStore";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import type { SemanticFlowNode } from "../../types";

const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(focusableSelector),
  ).filter(
    (element) =>
      element.getAttribute("aria-hidden") !== "true" &&
      !element.hasAttribute("hidden"),
  );
}

const commands = [
  { id: "map", label: "Ir al mapa del proyecto", keywords: "grafo explorar", hint: "Mapa", icon: Network },
  { id: "code", label: "Abrir código", keywords: "editor archivos", hint: "Código", icon: Code2 },
  { id: "terminal", label: "Abrir terminal del workspace", keywords: "consola shell", hint: "Terminal", icon: SquareTerminal },
  { id: "ask", label: "Preguntar sobre el proyecto", keywords: "asistente llm local", hint: "Preguntar", icon: Bot },
  { id: "act", label: "Actuar con Codex", keywords: "agente cambios", hint: "Codex", icon: Sparkles },
  { id: "fit", label: "Ajustar mapa a la ventana", keywords: "encuadrar zoom", hint: "Mapa", icon: Focus },
  { id: "reset-filters", label: "Restablecer filtros del mapa", keywords: "nodos extensiones", hint: "Mapa", icon: FilterX },
  { id: "close-tools", label: "Cerrar herramientas y volver al mapa", keywords: "ocultar paneles", hint: "Vista", icon: PanelTopClose },
  { id: "workspace", label: "Cambiar workspace", keywords: "proyecto carpeta abrir", hint: "Workspace", icon: FolderOpen },
  { id: "settings", label: "Abrir configuración", keywords: "proveedor modelo tema", hint: "Ajustes", icon: Settings2 },
  { id: "help", label: "Abrir ayuda y primeros pasos", keywords: "guía atajos", hint: "Ayuda", icon: CircleHelp },
] as const;

export const CommandPalette = memo(function CommandPalette() {
  const open = useShellStore((state) => state.commandPaletteOpen);
  const setOpen = useShellStore((state) => state.setCommandPaletteOpen);
  const setSettingsOpen = useShellStore((state) => state.setSettingsOpen);
  const setHelpOpen = useShellStore((state) => state.setHelpOpen);
  const setActiveTool = useWorkspaceStore((state) => state.setActiveTool);
  const setAssistantMode = useWorkspaceStore((state) => state.setAssistantMode);
  const resetCanvasFilters = useWorkspaceStore((state) => state.resetCanvasFilters);
  const activateSemanticNode = useWorkspaceStore((state) => state.activateSemanticNode);
  const nodes = useWorkspaceStore((state) => state.nodes);
  const openWorkspaceSelector = useWorkspaceManagerStore((state) => state.openSelector);
  const [query, setQuery] = useState("");
  const [activeOptionIndex, setActiveOptionIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(!useShellStore.getState().commandPaletteOpen);
      }
      if (
        event.key === "Escape" &&
        useShellStore.getState().commandPaletteOpen
      ) {
        event.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setOpen]);

  useEffect(() => {
    if (open) {
      previousFocusRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setQuery("");
      setActiveOptionIndex(0);
      const frame = window.requestAnimationFrame(() =>
        inputRef.current?.focus(),
      );
      return () => window.cancelAnimationFrame(frame);
    }

    const previousFocus = previousFocusRef.current;
    previousFocusRef.current = null;
    if (!previousFocus) return;
    const frame = window.requestAnimationFrame(() => {
      if (document.contains(previousFocus)) previousFocus.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("es");
    return needle
      ? commands.filter((command) =>
          `${command.label} ${command.keywords}`
            .toLocaleLowerCase("es")
            .includes(needle),
        )
      : commands;
  }, [query]);
  const semanticResults = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("es");
    if (!needle) return [];
    return nodes
      .filter((node): node is SemanticFlowNode => {
        if (node.type !== "semantic") return false;
        return `${node.data.label} ${node.data.relativePath ?? ""}`
          .toLocaleLowerCase("es")
          .includes(needle);
      })
      .slice(0, 8);
  }, [nodes, query]);
  const optionCount = filtered.length + semanticResults.length;

  const focusOption = (index: number) => {
    const options = Array.from(
      dialogRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="option"]',
      ) ?? [],
    );
    if (options.length === 0) return;
    const nextIndex = (index + options.length) % options.length;
    setActiveOptionIndex(nextIndex);
    options[nextIndex]?.focus();
  };

  const runCommand = (commandId: (typeof commands)[number]["id"]) => {
    if (commandId === "map" || commandId === "close-tools") {
      setActiveTool("map");
    } else if (commandId === "code") {
      setActiveTool("files");
    } else if (commandId === "terminal") {
      setActiveTool("terminal");
    } else if (commandId === "ask" || commandId === "act") {
      setAssistantMode(commandId === "act" ? "act" : "ask");
      setActiveTool("ai");
    } else if (commandId === "fit") {
      setActiveTool("map");
      window.dispatchEvent(new Event("constelix:fit-graph"));
    } else if (commandId === "reset-filters") {
      resetCanvasFilters();
      setActiveTool("map");
    } else if (commandId === "workspace") {
      void openWorkspaceSelector();
    } else if (commandId === "settings") {
      setSettingsOpen(true);
    } else if (commandId === "help") {
      setHelpOpen(true);
    }
    setOpen(false);
  };

  if (!open) return null;

  return (
    <div className="command-overlay" role="presentation" onMouseDown={() => setOpen(false)}>
      <section
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Paleta de comandos"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            focusOption(
              document.activeElement === inputRef.current
                ? 0
                : activeOptionIndex + 1,
            );
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            focusOption(
              document.activeElement === inputRef.current
                ? optionCount - 1
                : activeOptionIndex - 1,
            );
            return;
          }
          if (event.key === "Home" && document.activeElement !== inputRef.current) {
            event.preventDefault();
            focusOption(0);
            return;
          }
          if (event.key === "End" && document.activeElement !== inputRef.current) {
            event.preventDefault();
            focusOption(optionCount - 1);
            return;
          }
          if (event.key !== "Tab") return;
          const dialog = dialogRef.current;
          if (!dialog) return;
          const focusable = focusableElements(dialog);
          if (focusable.length === 0) {
            event.preventDefault();
            return;
          }
          const first = focusable[0];
          const last = focusable.at(-1);
          if (!first || !last) return;
          const activeElement = document.activeElement;
          if (event.shiftKey && (activeElement === first || !dialog.contains(activeElement))) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && (activeElement === last || !dialog.contains(activeElement))) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="command-input-row">
          <Search aria-hidden="true" size={17} />
          <input
            ref={inputRef}
            value={query}
            aria-label="Buscar comandos"
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar o ejecutar comando…"
          />
          <button type="button" aria-label="Cerrar" onClick={() => setOpen(false)}><X aria-hidden="true" size={16} /></button>
        </div>
        <div className="command-results" role="listbox">
          <p className="command-group-label">Comandos</p>
          {filtered.map((command, index) => {
            const Icon = command.icon;
            return (
              <button
                key={command.id}
                type="button"
                role="option"
                aria-selected={activeOptionIndex === index}
                onFocus={() => setActiveOptionIndex(index)}
                onClick={() => runCommand(command.id)}
              >
                <span className="command-result-icon"><Icon aria-hidden="true" size={16} /></span>
                <span>{command.label}</span>
                <kbd>{command.hint}</kbd>
              </button>
            );
          })}
          {semanticResults.length ? (
            <p className="command-group-label">Símbolos y archivos</p>
          ) : null}
          {semanticResults.map((node, index) => {
            const optionIndex = filtered.length + index;
            return (
            <button
              key={node.id}
              type="button"
              role="option"
              aria-selected={activeOptionIndex === optionIndex}
              onFocus={() => setActiveOptionIndex(optionIndex)}
              onClick={() => {
                void activateSemanticNode(node.id);
                setOpen(false);
              }}
            >
              <span className="command-result-icon"><Code2 aria-hidden="true" size={16} /></span>
              <span>
                {node.data.label}
                <small>{node.data.relativePath ?? node.data.kind}</small>
              </span>
              <kbd>{node.data.kind}</kbd>
            </button>
            );
          })}
          {filtered.length === 0 && semanticResults.length === 0 ? (
            <p className="command-empty">No hay comandos, símbolos ni archivos que coincidan.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
});
