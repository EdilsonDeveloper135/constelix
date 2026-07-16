import { Bot, Code2, FileSearch, Network, Search, SquareTerminal, X } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { useWorkspaceStore } from "../../store/useWorkspaceStore";

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
  { id: "map", label: "Enfocar mapa del proyecto", hint: "Mapa", icon: Network },
  { id: "search", label: "Buscar símbolos y archivos", hint: "Archivos", icon: FileSearch },
  { id: "editor", label: "Abrir editor", hint: "Panel", icon: Code2 },
  { id: "terminal", label: "Nueva terminal en el workspace", hint: "Panel", icon: SquareTerminal },
  { id: "ai", label: "Preguntar sobre el proyecto", hint: "IA", icon: Bot }
] as const;

export const CommandPalette = memo(function CommandPalette() {
  const open = useWorkspaceStore((state) => state.commandPaletteOpen);
  const setOpen = useWorkspaceStore((state) => state.setCommandPaletteOpen);
  const setActiveTool = useWorkspaceStore((state) => state.setActiveTool);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(!useWorkspaceStore.getState().commandPaletteOpen);
      }
      if (
        event.key === "Escape" &&
        useWorkspaceStore.getState().commandPaletteOpen
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
    return needle ? commands.filter((command) => command.label.toLocaleLowerCase("es").includes(needle)) : commands;
  }, [query]);

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
          {filtered.map((command) => {
            const Icon = command.icon;
            return (
              <button
                key={command.id}
                type="button"
                role="option"
                aria-selected="false"
                onClick={() => {
                  setActiveTool(command.id === "search" ? "files" : command.id);
                  setOpen(false);
                }}
              >
                <span className="command-result-icon"><Icon aria-hidden="true" size={16} /></span>
                <span>{command.label}</span>
                <kbd>{command.hint}</kbd>
              </button>
            );
          })}
          {filtered.length === 0 ? <p className="command-empty">No hay comandos que coincidan.</p> : null}
        </div>
      </section>
    </div>
  );
});
