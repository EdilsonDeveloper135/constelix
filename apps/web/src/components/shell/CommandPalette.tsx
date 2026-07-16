import { Bot, Code2, FileSearch, Network, Search, SquareTerminal, X } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { useWorkspaceStore } from "../../store/useWorkspaceStore";

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(!useWorkspaceStore.getState().commandPaletteOpen);
      }
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setOpen]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    window.setTimeout(() => inputRef.current?.focus(), 20);
  }, [open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("es");
    return needle ? commands.filter((command) => command.label.toLocaleLowerCase("es").includes(needle)) : commands;
  }, [query]);

  if (!open) return null;

  return (
    <div className="command-overlay" role="presentation" onMouseDown={() => setOpen(false)}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="Paleta de comandos" onMouseDown={(event) => event.stopPropagation()}>
        <div className="command-input-row">
          <Search aria-hidden="true" size={17} />
          <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar o ejecutar comando…" />
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
