import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Clock3,
  Folder,
  FolderOpen,
  LoaderCircle,
  X,
} from "lucide-react";
import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { useWorkspaceManagerStore } from "../../store/useWorkspaceManagerStore";

export const WorkspaceSwitcherDialog = memo(
  function WorkspaceSwitcherDialog() {
    const open = useWorkspaceManagerStore((state) => state.selectorOpen);
    const phase = useWorkspaceManagerStore((state) => state.phase);
    const recents = useWorkspaceManagerStore((state) => state.recents);
    const pathDraft = useWorkspaceManagerStore((state) => state.pathDraft);
    const browse = useWorkspaceManagerStore((state) => state.browse);
    const browseLoading = useWorkspaceManagerStore(
      (state) => state.browseLoading,
    );
    const nativePickerBusy = useWorkspaceManagerStore(
      (state) => state.nativePickerBusy,
    );
    const errorMessage = useWorkspaceManagerStore(
      (state) => state.errorMessage,
    );
    const lockConflict = useWorkspaceManagerStore(
      (state) => state.lockConflict,
    );
    const close = useWorkspaceManagerStore((state) => state.closeSelector);
    const setPathDraft = useWorkspaceManagerStore(
      (state) => state.setPathDraft,
    );
    const browsePath = useWorkspaceManagerStore((state) => state.browsePath);
    const pickNativeFolder = useWorkspaceManagerStore(
      (state) => state.pickNativeFolder,
    );
    const loadMoreBrowse = useWorkspaceManagerStore(
      (state) => state.loadMoreBrowse,
    );
    const requestSwitch = useWorkspaceManagerStore(
      (state) => state.requestSwitch,
    );
    const confirmDirtyDrafts = useWorkspaceManagerStore(
      (state) => state.confirmDirtyDrafts,
    );
    const forceReleaseAndSwitch = useWorkspaceManagerStore(
      (state) => state.forceReleaseAndSwitch,
    );
    const [filter, setFilter] = useState("");
    const dialogRef = useRef<HTMLElement>(null);
    const filterRef = useRef<HTMLInputElement>(null);
    const guardRef = useRef<HTMLDivElement>(null);
    const titleId = useId();
    const descriptionId = useId();
    const switching = phase === "validating" || phase === "activating";
    const selectionBusy = switching || phase === "loading" || nativePickerBusy;

    const visibleRecents = useMemo(() => {
      const normalized = filter.trim().toLocaleLowerCase();
      return normalized
        ? recents.filter((workspace) =>
            `${workspace.name} ${workspace.displayPath}`
              .toLocaleLowerCase()
              .includes(normalized),
          )
        : recents;
    }, [filter, recents]);

    useEffect(() => {
      if (!open) return;
      const previous = document.activeElement as HTMLElement | null;
      const frame = window.requestAnimationFrame(() => filterRef.current?.focus());
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape" && !switching) {
          event.preventDefault();
          close();
          return;
        }
        if (
          event.altKey &&
          event.key === "ArrowUp" &&
          browse?.parentPath
        ) {
          event.preventDefault();
          void browsePath(browse.parentPath);
          return;
        }
        if (event.key !== "Tab" || !dialogRef.current) return;
        const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])",
        )];
        const first = focusable.at(0);
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
      document.addEventListener("keydown", onKeyDown);
      return () => {
        window.cancelAnimationFrame(frame);
        document.removeEventListener("keydown", onKeyDown);
        (previous ?? document.querySelector<HTMLElement>(
          "[data-workspace-trigger]",
        ))?.focus();
      };
    }, [browse?.parentPath, browsePath, close, open, switching]);

    useEffect(() => {
      if (
        !open ||
        (phase !== "dirtyGuard" && !lockConflict)
      ) {
        return;
      }
      const frame = window.requestAnimationFrame(() =>
        guardRef.current?.focus(),
      );
      return () => window.cancelAnimationFrame(frame);
    }, [lockConflict, open, phase]);

    if (!open) return null;

    return (
      <div className="workspace-switcher-overlay">
        <section
          ref={dialogRef}
          className="workspace-switcher"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          aria-busy={switching}
        >
          <header className="workspace-switcher__header">
            <div>
              <p>Workspace local</p>
              <h2 id={titleId}>Cambiar workspace</h2>
              <span id={descriptionId}>
                Abre una carpeta sin recargar Constelix.
              </span>
            </div>
            <button
              type="button"
              aria-label="Cerrar selector de workspace"
              disabled={switching}
              onClick={close}
            >
              <X aria-hidden="true" size={17} />
            </button>
          </header>

          {phase === "dirtyGuard" ? (
            <div
              ref={guardRef}
              className="workspace-switcher__guard"
              role="alert"
              tabIndex={-1}
            >
              <AlertTriangle aria-hidden="true" size={20} />
              <div>
                <h3>Hay cambios sin guardar</h3>
                <p>
                  Puedes conservar los borradores para recuperarlos al volver,
                  o descartarlos antes del cambio.
                </p>
              </div>
              <div className="workspace-switcher__actions">
                <button
                  type="button"
                  onClick={() => void confirmDirtyDrafts("cancel")}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => void confirmDirtyDrafts("discard")}
                >
                  Descartar
                </button>
                <button
                  className="workspace-switcher__primary"
                  type="button"
                  onClick={() => void confirmDirtyDrafts("preserve")}
                >
                  Conservar y cambiar
                </button>
              </div>
            </div>
          ) : lockConflict ? (
            <div
              ref={guardRef}
              className="workspace-switcher__guard"
              role="alert"
              tabIndex={-1}
            >
              <AlertTriangle aria-hidden="true" size={20} />
              <div>
                <h3>Workspace en uso</h3>
                <p>
                  {lockConflict.status === "active"
                    ? "Otra instancia de Constelix mantiene una sesión activa. Ciérrala antes de continuar."
                    : "No pudimos confirmar que la sesión siga activa. Forzar la liberación puede interrumpir otra instancia."}
                </p>
                <dl className="workspace-switcher__lock-details">
                  {lockConflict.pid ? (
                    <>
                      <dt>PID</dt>
                      <dd>{lockConflict.pid}</dd>
                    </>
                  ) : null}
                  {lockConflict.agentVersion ? (
                    <>
                      <dt>Agente</dt>
                      <dd>{lockConflict.agentVersion}</dd>
                    </>
                  ) : null}
                  {lockConflict.heartbeatAt ? (
                    <>
                      <dt>Último heartbeat</dt>
                      <dd>
                        {new Date(lockConflict.heartbeatAt).toLocaleString()}
                      </dd>
                    </>
                  ) : null}
                </dl>
              </div>
              <div className="workspace-switcher__actions">
                <button type="button" onClick={close}>Cancelar</button>
                {lockConflict.forceAllowed ? (
                  <button
                    className="workspace-switcher__danger"
                    type="button"
                    onClick={() => void forceReleaseAndSwitch()}
                  >
                    Forzar liberación
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <>
              <div className="workspace-switcher__path">
                <div className="workspace-switcher__path-heading">
                  <label htmlFor="workspace-path">Carpeta del workspace</label>
                  <button
                    type="button"
                    disabled={selectionBusy}
                    onClick={() => void pickNativeFolder()}
                  >
                    {nativePickerBusy ? <LoaderCircle className="spin" aria-hidden="true" size={14} /> : <FolderOpen aria-hidden="true" size={14} />}
                    Elegir carpeta…
                  </button>
                </div>
                <div>
                  <input
                    id="workspace-path"
                    value={pathDraft}
                    placeholder="/Users/tu-usuario/Proyectos/mi-app"
                    spellCheck={false}
                    onChange={(event) => setPathDraft(event.target.value)}
                  />
                  <button
                    type="button"
                    disabled={!pathDraft.startsWith("/") || selectionBusy}
                    onClick={() =>
                      void requestSwitch({
                        kind: "path",
                        path: pathDraft,
                      })
                    }
                  >
                    <FolderOpen aria-hidden="true" size={15} />
                    Abrir workspace
                  </button>
                </div>
              </div>

              <div className="workspace-switcher__body">
                <section aria-labelledby={`${titleId}-recents`}>
                  <div className="workspace-switcher__section-title">
                    <h3 id={`${titleId}-recents`}>
                      <Clock3 aria-hidden="true" size={14} />
                      Recientes
                    </h3>
                  </div>
                  <input
                    ref={filterRef}
                    className="workspace-switcher__filter"
                    type="search"
                    aria-label="Filtrar workspaces recientes"
                    placeholder="Filtrar recientes…"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  />
                  <div className="workspace-switcher__list">
                    {visibleRecents.map((workspace) => (
                      <button
                        key={workspace.workspaceId}
                        type="button"
                        disabled={
                          workspace.availability === "missing" ||
                          workspace.availability === "unreadable" ||
                          selectionBusy
                        }
                        onClick={() =>
                          void requestSwitch({
                            kind: "recent",
                            workspaceId: workspace.workspaceId,
                          })
                        }
                      >
                        <Folder aria-hidden="true" size={16} />
                        <span>
                          <strong>{workspace.name}</strong>
                          <small>{workspace.displayPath}</small>
                        </span>
                        {workspace.availability === "available" ? (
                          <Check aria-hidden="true" size={14} />
                        ) : (
                          <small>{availabilityLabel(workspace.availability)}</small>
                        )}
                      </button>
                    ))}
                    {!visibleRecents.length && phase !== "loading" ? (
                      <p>No hay workspaces recientes que coincidan.</p>
                    ) : null}
                  </div>
                </section>

                <section aria-labelledby={`${titleId}-browser`}>
                  <div className="workspace-switcher__section-title">
                    <h3 id={`${titleId}-browser`}>
                      <FolderOpen aria-hidden="true" size={14} />
                      Explorar carpetas
                    </h3>
                    <button
                      type="button"
                      aria-label="Subir a la carpeta superior"
                      disabled={
                        !browse?.parentPath ||
                        browseLoading ||
                        selectionBusy
                      }
                      onClick={() =>
                        browse?.parentPath
                          ? void browsePath(browse.parentPath)
                          : undefined
                      }
                    >
                      <ArrowLeft aria-hidden="true" size={14} />
                    </button>
                  </div>
                  <button
                    className="workspace-switcher__browse-current"
                    type="button"
                    disabled={browseLoading || selectionBusy}
                    onClick={() =>
                      void browsePath(
                        pathDraft.startsWith("/") ? pathDraft : "",
                      )
                    }
                  >
                    {browseLoading ? (
                      <LoaderCircle
                        className="spin"
                        aria-hidden="true"
                        size={15}
                      />
                    ) : (
                      <FolderOpen aria-hidden="true" size={15} />
                    )}
                    {browse ? browse.path : "Explorar carpeta personal"}
                  </button>
                  <div className="workspace-switcher__list">
                    {browse?.entries.map((entry) => (
                      <button
                        key={entry.path}
                        type="button"
                        disabled={browseLoading || selectionBusy}
                        onClick={() => void browsePath(entry.path)}
                      >
                        <Folder aria-hidden="true" size={16} />
                        <span>
                          <strong>{entry.name}</strong>
                          {entry.symlink ? <small>Enlace simbólico</small> : null}
                        </span>
                      </button>
                    ))}
                  </div>
                  {browse?.truncated && browse.cursor ? (
                    <button
                      className="workspace-switcher__load-more"
                      type="button"
                      aria-busy={browseLoading}
                      aria-label={
                        browseLoading
                          ? "Cargando más carpetas"
                          : "Cargar más carpetas"
                      }
                      disabled={browseLoading || selectionBusy}
                      onClick={() => void loadMoreBrowse()}
                    >
                      {browseLoading ? (
                        <LoaderCircle
                          className="spin"
                          aria-hidden="true"
                          size={14}
                        />
                      ) : null}
                      <span aria-live="polite">
                        {browseLoading
                          ? "Cargando más carpetas…"
                          : "Cargar más carpetas"}
                      </span>
                    </button>
                  ) : null}
                  {browse ? (
                    <button
                      className="workspace-switcher__primary workspace-switcher__open-current"
                      type="button"
                      disabled={switching || browseLoading}
                      onClick={() =>
                        void requestSwitch({
                          kind: "path",
                          path: browse.path,
                        })
                      }
                    >
                      Abrir esta carpeta
                    </button>
                  ) : null}
                </section>
              </div>
            </>
          )}

          {switching || phase === "loading" ? (
            <div className="workspace-switcher__status" role="status">
              <LoaderCircle className="spin" aria-hidden="true" size={15} />
              {phase === "activating"
                ? "Cambiando de workspace…"
                : phase === "validating"
                  ? "Validando carpeta…"
                  : "Cargando workspaces…"}
            </div>
          ) : null}
          {errorMessage && phase === "error" ? (
            <div className="workspace-switcher__error" role="alert">
              <AlertTriangle aria-hidden="true" size={15} />
              {errorMessage}
            </div>
          ) : null}
        </section>
      </div>
    );
  },
);

function availabilityLabel(
  availability: "available" | "missing" | "unreadable" | "locked" | "unknown",
): string {
  if (availability === "missing") return "No disponible";
  if (availability === "unreadable") return "Sin permiso";
  if (availability === "locked") return "En uso";
  if (availability === "unknown") return "Sin verificar";
  return "Disponible";
}
