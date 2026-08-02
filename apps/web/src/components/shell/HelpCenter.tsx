import {
  Bot,
  CircleHelp,
  Code2,
  Command,
  Network,
  Settings2,
  Sparkles,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  memo,
  useEffect,
  useRef,
  type KeyboardEvent,
} from "react";

import { useShellStore } from "../../store/useShellStore";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";

const focusableSelector = [
  "button:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export const HelpCenter = memo(function HelpCenter() {
  const open = useShellStore((state) => state.helpOpen);
  const setOpen = useShellStore((state) => state.setHelpOpen);
  const setSettingsOpen = useShellStore((state) => state.setSettingsOpen);
  const setActiveTool = useWorkspaceStore((state) => state.setActiveTool);
  const askMode = useWorkspaceStore((state) => state.askMode);
  const actAvailable = useWorkspaceStore((state) => state.actAvailable);
  const workspaceMode = useWorkspaceStore((state) => state.workspaceMode);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  if (!open) return null;

  const close = () => {
    setOpen(false);
    const returnFocus = returnFocusRef.current;
    returnFocusRef.current = null;
    window.requestAnimationFrame(() => returnFocus?.focus());
  };
  const activate = (tool: "map" | "files" | "terminal" | "ai") => {
    setActiveTool(tool);
    close();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="help-center-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={dialogRef}
        className="help-center"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-center-title"
        onKeyDown={handleKeyDown}
      >
        <header className="help-center__header">
          <span><CircleHelp aria-hidden="true" size={20} /></span>
          <div>
            <h2 id="help-center-title">Entiende tu código con contexto</h2>
            <p>Explora el mapa, abre evidencia y actúa solo cuando estés listo.</p>
          </div>
          <button ref={closeRef} type="button" aria-label="Cerrar ayuda" onClick={close}>
            <X aria-hidden="true" size={17} />
          </button>
        </header>

        <div className="help-center__workflow" aria-label="Primeros pasos">
          <article>
            <span><Network aria-hidden="true" size={18} /></span>
            <div><strong>1. Explora</strong><p>Selecciona un nodo para ver su archivo y sus relaciones.</p></div>
            <button type="button" onClick={() => activate("map")}>Ir al mapa</button>
          </article>
          <article>
            <span><Code2 aria-hidden="true" size={18} /></span>
            <div><strong>2. Comprueba</strong><p>Abre el código exacto antes de sacar conclusiones.</p></div>
            <button type="button" onClick={() => activate("files")}>Abrir código</button>
          </article>
          <article>
            <span><Bot aria-hidden="true" size={18} /></span>
            <div><strong>3. Pregunta</strong><p>Usa búsqueda local o conecta un LLM para explicaciones generadas.</p></div>
            <button type="button" onClick={() => activate("ai")}>Preguntar</button>
          </article>
          <article>
            <span><SquareTerminal aria-hidden="true" size={18} /></span>
            <div><strong>4. Actúa</strong><p>Terminal y Codex permanecen separados de la exploración hasta que los abras.</p></div>
            <button type="button" onClick={() => activate("terminal")}>Abrir terminal</button>
          </article>
        </div>

        <div className="help-center__status">
          <Sparkles aria-hidden="true" size={17} />
          <div>
            <strong>Capacidades actuales</strong>
            <p>
              Preguntar: {askMode === "openai" ? "LLM conectado" : "búsqueda local"}.{" "}
              Actuar: {workspaceMode === "read" ? "bloqueado en modo lectura" : actAvailable ? "Codex listo" : "requiere Codex CLI compatible"}.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              close();
              setSettingsOpen(true);
            }}
          >
            <Settings2 aria-hidden="true" size={15} /> Configurar
          </button>
        </div>

        <footer className="help-center__footer">
          <span><Command aria-hidden="true" size={14} /> K abre todos los comandos</span>
          <button type="button" onClick={close}>Entendido</button>
        </footer>
      </section>
    </div>
  );
});
