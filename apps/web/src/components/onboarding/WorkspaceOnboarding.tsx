import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Eye,
  FileCode2,
  FolderSearch2,
  Languages,
  Network,
  Pencil,
  RotateCcw,
} from "lucide-react";
import { memo } from "react";

import { useFocusTrap } from "../../hooks/useFocusTrap";
import { summarizeWorkspacePath } from "../../lib/workspacePresentation";
import { useShellStore } from "../../store/useShellStore";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";

export const WorkspaceOnboarding = memo(function WorkspaceOnboarding() {
  const demoMode = useWorkspaceStore((state) => state.demoMode);
  const remoteHydrated = useWorkspaceStore((state) => state.remoteHydrated);
  const connection = useWorkspaceStore((state) => state.connection);
  const bootstrapError = useWorkspaceStore((state) => state.assistantError);
  const onboardingOpen = useShellStore((state) => state.onboardingOpen);
  const workspaceName = useWorkspaceStore((state) => state.workspaceName);
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const workspaceMode = useWorkspaceStore((state) => state.workspaceMode);
  const summary = useWorkspaceStore((state) => state.workspaceSummary);
  const index = useWorkspaceStore((state) => state.index);
  const setOnboardingOpen = useShellStore(
    (state) => state.setOnboardingOpen,
  );
  const setHelpOpen = useShellStore((state) => state.setHelpOpen);

  const open = !demoMode && onboardingOpen;
  const { containerRef, onKeyDown } = useFocusTrap<HTMLElement>({
    open,
    onClose: () => setOnboardingOpen(false),
  });

  if (!open) return null;
  const progress = Math.round(index.progress * 100);
  const ready = index.phase === "ready";
  const stalled = !remoteHydrated && connection === "degraded";

  return (
    <div className={`onboarding-overlay${remoteHydrated ? " onboarding-overlay--ready" : ""}`}>
      <section
        ref={containerRef}
        className="workspace-onboarding"
        role="dialog"
        aria-modal={remoteHydrated ? undefined : "true"}
        aria-labelledby="workspace-onboarding-title"
        aria-describedby="workspace-onboarding-description"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="onboarding-heading">
          <span className="onboarding-icon">
            <FolderSearch2 aria-hidden="true" size={22} />
          </span>
          <div>
            <p>Workspace local</p>
            <h1 id="workspace-onboarding-title">
              {remoteHydrated ? workspaceName : "Validando proyecto…"}
            </h1>
            <span id="workspace-onboarding-description" title={rootPath}>
              {summarizeWorkspacePath(rootPath)}
            </span>
          </div>
          {remoteHydrated ? (
            <span
              className={`onboarding-mode onboarding-mode--${workspaceMode}`}
            >
              {workspaceMode === "read" ? (
                <Eye aria-hidden="true" size={13} />
              ) : (
                <Pencil aria-hidden="true" size={13} />
              )}
              {workspaceMode === "read" ? "Modo Lectura" : "Modo Edición"}
            </span>
          ) : null}
        </div>

        <div className="onboarding-purpose">
          <Network aria-hidden="true" size={21} />
          <div>
            <h2>Explora el código. Entiende relaciones. Actúa con contexto.</h2>
            <p>
              El mapa es tu punto de partida. Código, Terminal y Preguntar se
              abren únicamente cuando los necesitas.
            </p>
          </div>
        </div>

        <div className="onboarding-summary">
          <article>
            <FileCode2 aria-hidden="true" size={16} />
            <span>Archivos detectados</span>
            <strong>
              {summary.estimatedFileCount.toLocaleString()}
            </strong>
          </article>
          <article>
            <Languages aria-hidden="true" size={16} />
            <span>Lenguajes</span>
            <strong>
              {summary.languages.length
                ? summary.languages.join(", ")
                : "Detectando…"}
            </strong>
          </article>
          <article>
            <CheckCircle2 aria-hidden="true" size={16} />
            <span>Tipo de proyecto</span>
            <strong>
              {summary.projectTypes.length
                ? summary.projectTypes.join(", ")
                : "Proyecto de código"}
            </strong>
          </article>
        </div>

        {summary.warnings.length || summary.omittedFileCount ? (
          <div className="onboarding-warnings" role="status">
            <AlertTriangle aria-hidden="true" size={15} />
            <div>
              {summary.warnings.slice(0, 3).map((warning) => (
                <p key={`${warning.code}:${warning.relativePath ?? ""}`}>
                  {warning.message}
                </p>
              ))}
              {summary.omittedFileCount ? (
                <p>
                  {summary.omittedFileCount.toLocaleString()} archivo
                  {summary.omittedFileCount === 1 ? "" : "s"} omitido
                  {summary.omittedFileCount === 1 ? "" : "s"} por límites o
                  seguridad.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        {stalled ? (
          <div className="onboarding-error" role="alert">
            <AlertTriangle aria-hidden="true" size={15} />
            <div>
              <p>
                <strong>No se pudo validar el workspace.</strong>{" "}
                {bootstrapError ??
                  "El agente local no respondió. Verifica que siga en ejecución."}
              </p>
              <button
                type="button"
                onClick={() => void useWorkspaceStore.getState().reconcileGraph()}
              >
                <RotateCcw aria-hidden="true" size={13} /> Reintentar
              </button>
            </div>
          </div>
        ) : (
          <div className="onboarding-progress">
            <div>
              <span>
                {ready
                  ? "Índice local listo"
                  : index.message ?? "Preparando el índice local…"}
              </span>
              <strong>{progress}%</strong>
            </div>
            <div
              className="onboarding-progress-track"
              role="progressbar"
              aria-label="Progreso de indexación"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
            >
              <span style={{ width: `${progress}%` }} />
            </div>
            <small>
              {index.filesIndexed.toLocaleString()} archivos ·{" "}
              {index.symbolsIndexed.toLocaleString()} símbolos
            </small>
          </div>
        )}

        <div className="onboarding-actions">
          <p>
            {workspaceMode === "read"
              ? "Puedes explorar, consultar y usar terminales. La edición y Actuar permanecen bloqueados."
              : "El grafo seguirá actualizándose mientras trabajas."}
          </p>
          <div>
            <button
              type="button"
              className="onboarding-skip"
              disabled={!remoteHydrated}
              onClick={() => setOnboardingOpen(false)}
            >
              Omitir
            </button>
            <button
              type="button"
              disabled={!remoteHydrated}
              onClick={() => {
                setOnboardingOpen(false);
                setHelpOpen(true);
              }}
            >
              Iniciar recorrido <ArrowRight aria-hidden="true" size={15} />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
});
