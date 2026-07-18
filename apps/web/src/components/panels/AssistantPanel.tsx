import { AlertTriangle, Bot, Check, Copy, Play, Send, ShieldCheck, Sparkles, Square, X } from "lucide-react";
import { memo, useMemo, useRef, type KeyboardEvent } from "react";
import type { NodeProps } from "@xyflow/react";

import { nextHorizontalTabIndex } from "../../lib/keyboardNavigation";
import { canUseWorkspaceFeatures } from "../../lib/workspaceAccess";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import type { AssistantFlowNode, AssistantMode, SemanticFlowNode } from "../../types";
import { PanelFrame } from "./PanelFrame";

const assistantModes = ["ask", "act"] as const satisfies readonly AssistantMode[];

export const AssistantPanel = memo(function AssistantPanel({ id, data, height }: NodeProps<AssistantFlowNode>) {
  const mode = useWorkspaceStore((state) => state.assistantMode);
  const setMode = useWorkspaceStore((state) => state.setAssistantMode);
  const question = useWorkspaceStore((state) => state.question);
  const setQuestion = useWorkspaceStore((state) => state.setQuestion);
  const answer = useWorkspaceStore((state) => state.answer);
  const conversation = useWorkspaceStore((state) => state.conversation);
  const error = useWorkspaceStore((state) => state.assistantError);
  const thinking = useWorkspaceStore((state) => state.assistantThinking);
  const evidencePath = useWorkspaceStore((state) => state.evidencePath);
  const evidencePartial = useWorkspaceStore((state) => state.evidencePartial);
  const semanticVersion = useWorkspaceStore((state) => state.semanticVersion);
  const submitQuestion = useWorkspaceStore((state) => state.submitQuestion);
  const cancelQuestion = useWorkspaceStore((state) => state.cancelQuestion);
  const navigateEvidence = useWorkspaceStore((state) => state.navigateEvidence);
  const playEvidencePath = useWorkspaceStore((state) => state.playEvidencePath);
  const actTask = useWorkspaceStore((state) => state.actTask);
  const askAvailable = useWorkspaceStore((state) => state.askAvailable);
  const askMode = useWorkspaceStore((state) => state.askMode);
  const askNotice = useWorkspaceStore((state) => state.askNotice);
  const workspaceMode = useWorkspaceStore((state) => state.workspaceMode);
  const actAvailable = useWorkspaceStore((state) => state.actAvailable);
  const codexReason = useWorkspaceStore((state) => state.codexReason);
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const demoMode = useWorkspaceStore((state) => state.demoMode);
  const remoteHydrated = useWorkspaceStore((state) => state.remoteHydrated);
  const connection = useWorkspaceStore((state) => state.connection);
  const createActTask = useWorkspaceStore((state) => state.createActTask);
  const approveActTask = useWorkspaceStore((state) => state.approveActTask);
  const cancelActTask = useWorkspaceStore((state) => state.cancelActTask);
  const resetActTask = useWorkspaceStore((state) => state.resetActTask);
  const askTabRef = useRef<HTMLButtonElement>(null);
  const actTabRef = useRef<HTMLButtonElement>(null);

  const nodeLabels = useMemo(
    () =>
      new Map(
      useWorkspaceStore
        .getState()
        .nodes
        .filter((node): node is SemanticFlowNode => node.type === "semantic")
          .map((node) => [node.id, node.data.label]),
      ),
    [semanticVersion],
  );
  const evidenceLabels = useMemo(
    () =>
      evidencePath?.nodeIds.map((nodeId) => ({
        id: nodeId,
        label: nodeLabels.get(nodeId) ?? nodeId,
      })) ?? [],
    [evidencePath, nodeLabels],
  );
  const copyableAnswer =
    answer || conversation.findLast((message) => message.role === "assistant")?.content || "";
  const workspaceReady = canUseWorkspaceFeatures({
    demoMode,
    remoteHydrated,
    connection,
  });
  const askReady = workspaceReady && askAvailable;

  const selectTab = (nextMode: AssistantMode, focus = false) => {
    setMode(nextMode);
    if (!focus) return;
    const target = nextMode === "ask" ? askTabRef.current : actTabRef.current;
    window.requestAnimationFrame(() => target?.focus());
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = assistantModes.indexOf(mode);
    const nextIndex = nextHorizontalTabIndex(
      currentIndex,
      event.key,
      assistantModes.length,
    );
    if (nextIndex === null) return;
    event.preventDefault();
    const nextMode = assistantModes[nextIndex];
    if (nextMode) selectTab(nextMode, true);
  };

  return (
    <PanelFrame
      id={id}
      title={data.title}
      icon={<Sparkles aria-hidden="true" size={14} />}
      minWidth={480}
      minHeight={180}
      currentHeight={height}
      collapsed={data.collapsed}
      expandedHeight={data.expandedHeight}
      accent="violet"
      className="assistant-panel"
    >
      <div className="assistant-tabs" role="tablist" aria-label="Modo de inteligencia artificial">
        <button
          ref={askTabRef}
          id="assistant-tab-ask"
          type="button"
          role="tab"
          aria-controls="assistant-panel-ask"
          aria-selected={mode === "ask"}
          tabIndex={mode === "ask" ? 0 : -1}
          className={mode === "ask" ? "active" : ""}
          onClick={() => selectTab("ask")}
          onKeyDown={handleTabKeyDown}
        >
          <Bot aria-hidden="true" size={13} /> Preguntar
        </button>
        <button
          ref={actTabRef}
          id="assistant-tab-act"
          type="button"
          role="tab"
          aria-controls="assistant-panel-act"
          aria-selected={mode === "act"}
          tabIndex={mode === "act" ? 0 : -1}
          className={mode === "act" ? "active" : ""}
          onClick={() => selectTab("act")}
          onKeyDown={handleTabKeyDown}
        >
          <Play aria-hidden="true" size={12} /> Actuar
        </button>
      </div>

      {mode === "ask" ? (
        <div
          id="assistant-panel-ask"
          className="ask-layout"
          role="tabpanel"
          aria-labelledby="assistant-tab-ask"
          data-testid="ask-panel"
        >
          <div className="ask-question-column">
            <label htmlFor="constelix-question">Pregunta</label>
            <textarea
              id="constelix-question"
              value={question}
              disabled={!askReady}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (
                  askReady &&
                  event.key === "Enter" &&
                  (event.metaKey || event.ctrlKey)
                ) {
                  event.preventDefault();
                  void submitQuestion();
                }
              }}
              placeholder={
                !workspaceReady
                  ? "Conectando con el agente local…"
                  : askAvailable
                    ? "Pregunta sobre el proyecto…"
                    : "OpenAI no está disponible para este workspace."
              }
            />
            {workspaceReady && askMode === "local" ? (
              <p className="ask-mode-notice" role="status">
                <AlertTriangle aria-hidden="true" size={12} />
                <span>
                  <strong>Ask Local no genera explicaciones.</strong>{" "}
                  Busca archivos, símbolos, fragmentos y relaciones directamente
                  en el índice local.
                </span>
              </p>
            ) : null}
            {workspaceReady && askNotice ? (
              <p className="ask-provider-notice" role="status">
                {askNotice}
              </p>
            ) : null}
            {workspaceReady && !askAvailable ? (
              <p className="assistant-error" role="status">
                Preguntar está deshabilitado porque el agente no tiene un proveedor OpenAI disponible.
              </p>
            ) : null}
            <div className="ask-submit-row">
              <span>⌘ ↵ para enviar</span>
              <button
                type="button"
                disabled={!thinking && (!askReady || !question.trim())}
                onClick={() => thinking ? cancelQuestion() : void submitQuestion()}
              >
                {thinking ? <Square aria-hidden="true" size={11} /> : <Send aria-hidden="true" size={12} />}
                {thinking ? "Detener" : "Consultar"}
              </button>
            </div>
          </div>
          <div className="ask-answer-column" aria-live="polite">
            <div className="ask-answer-heading">
              <span>Conversación</span>
              {copyableAnswer ? <button type="button" aria-label="Copiar última respuesta" onClick={() => void navigator.clipboard.writeText(copyableAnswer)}><Copy aria-hidden="true" size={12} /></button> : null}
            </div>
            {conversation.length ? (
              <div className="conversation-history" role="log" aria-label="Historial de conversación">
                {conversation.map((message, messageIndex) => {
                  const messageEvidence = message.evidence;
                  const messageEvidenceLabels =
                    messageEvidence?.nodeIds.map((nodeId) => ({
                      id: nodeId,
                      label: nodeLabels.get(nodeId) ?? nodeId,
                    })) ?? [];
                  return (
                    <article
                      key={`${message.role}-${messageIndex}-${message.content.slice(0, 24)}`}
                      className={`conversation-message conversation-message--${message.role}`}
                    >
                      <span>
                        {message.role === "user" ? "Tú" : "Constelix"}
                        {message.role === "assistant" && message.mode
                          ? ` · ${message.mode === "local" ? "Ask Local" : "Ask OpenAI"}`
                          : ""}
                      </span>
                      <p>{message.content}</p>
                      {message.localResult ? (
                        <div
                          className="local-ask-results"
                          aria-label={`Resultados locales de la consulta ${messageIndex + 1}`}
                        >
                          {message.localResult.hits.length ? (
                            message.localResult.hits.map((hit) => (
                              <article
                                key={hit.nodeId}
                                className="local-ask-card"
                              >
                                <button
                                  type="button"
                                  onClick={() =>
                                    void navigateEvidence(hit.nodeId)
                                  }
                                >
                                  <span>
                                    <strong>{hit.name}</strong>
                                    <small>{hit.kind}</small>
                                  </span>
                                  <code>{hit.relativePath}</code>
                                </button>
                                {hit.signature ? <p>{hit.signature}</p> : null}
                                {hit.snippet ? (
                                  <pre>
                                    <code>{hit.snippet.content}</code>
                                  </pre>
                                ) : null}
                                <small>
                                  {hit.relations.length} relación
                                  {hit.relations.length === 1 ? "" : "es"} ·
                                  coincidencia{" "}
                                  {hit.matchedFields.join(", ")}
                                </small>
                              </article>
                            ))
                          ) : (
                            <p className="local-ask-empty">
                              No se encontraron coincidencias verificables en
                              el índice local.
                            </p>
                          )}
                          {message.localResult.limitations.map(
                            (limitation, limitationIndex) => (
                              <p
                                key={`${limitationIndex}:${limitation}`}
                                className="local-ask-limitation"
                              >
                                {limitation}
                              </p>
                            ),
                          )}
                        </div>
                      ) : null}
                      {messageEvidence && messageEvidenceLabels.length ? (
                        <div className="evidence-path" aria-label={`Evidencia de la respuesta ${messageIndex + 1}`}>
                          {messageEvidenceLabels.map((item, index) => (
                            <span key={item.id}>
                              <button
                                type="button"
                                onClick={() => {
                                  playEvidencePath(messageEvidence);
                                  void navigateEvidence(item.id);
                                }}
                              >
                                {item.label}
                              </button>
                              {index < messageEvidenceLabels.length - 1 ? <i aria-hidden="true">→</i> : null}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            ) : null}
            {thinking && !answer ? <div className="answer-thinking"><span /><span /><span /> Consultando el grafo…</div> : null}
            {error ? <p className="assistant-error" role="alert">{error}</p> : null}
            {answer ? <p className="answer-copy answer-copy--streaming">{answer}</p> : !conversation.length && !thinking && !error ? <p className="answer-placeholder">{workspaceReady ? "La respuesta mostrará evidencia verificable del grafo." : "Conectando con el workspace antes de habilitar consultas y tareas…"}</p> : null}
            {(answer || thinking) && evidenceLabels.length ? (
              <div>
                {evidencePartial ? (
                  <p className="evidence-partial" role="status">
                    Evidencia parcial: algunos nodos todavía no pudieron cargarse en el canvas.
                  </p>
                ) : null}
                <div className="evidence-path" aria-label="Recorrido de evidencia">
                  {evidenceLabels.map((item, index) => (
                    <span key={item.id}>
                      <button type="button" onClick={() => void navigateEvidence(item.id)}>{item.label}</button>
                      {index < evidenceLabels.length - 1 ? <i aria-hidden="true">→</i> : null}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div
          id="assistant-panel-act"
          className="act-layout"
          role="tabpanel"
          aria-labelledby="assistant-tab-act"
          data-testid="act-panel"
        >
          {!actAvailable || workspaceMode === "read" ? (
            <div className="act-unavailable"><AlertTriangle aria-hidden="true" size={18} /><div><strong>{workspaceMode === "read" ? "Actuar bloqueado en Modo Lectura" : workspaceReady ? "Codex local no disponible" : "Conectando con el agente local"}</strong><p>{workspaceMode === "read" ? "Vuelve a abrir un workspace con permisos de escritura para delegar cambios a Codex." : codexReason ?? (workspaceReady ? "Instala o actualiza Codex CLI para habilitar este modo." : "Las tareas se habilitarán después de validar el workspace y sus capacidades.")}</p></div></div>
          ) : actTask === null ? (
            <>
              <div className="act-copy">
                <ShieldCheck aria-hidden="true" size={24} />
                <div>
                  <strong>Delegación con aprobación</strong>
                  <p>Codex podrá escribir y ejecutar comandos dentro del workspace. La red estará habilitada; las rutas externas permanecen bloqueadas.</p>
                  <p><strong>Act solo debe aprobarse en repositorios confiables.</strong></p>
                </div>
              </div>
              <label className="act-objective" htmlFor="constelix-act-objective">
                Objetivo del turno
                <textarea
                  id="constelix-act-objective"
                  value={question}
                  disabled={!workspaceReady}
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder="Describe una tarea concreta para Codex…"
                />
              </label>
              <p className="act-scope-root"><strong>Raíz protegida:</strong> <code>{rootPath}</code></p>
              {error ? <p className="assistant-error" role="alert">{error}</p> : null}
              <button className="act-primary" type="button" disabled={!workspaceReady || !question.trim()} onClick={() => void createActTask()}>Preparar tarea</button>
            </>
          ) : actTask.status === "awaitingApproval" ? (
            <div className="approval-card">
              <div><AlertTriangle aria-hidden="true" size={17} /><strong>Revisa antes de aprobar</strong></div>
              <p>{actTask.objective}</p>
              <p role="note"><strong>Repositorio confiable:</strong> aprueba este turno únicamente si reconoces y confías en el contenido del repositorio.</p>
              <ul>
                <li>Raíz: <code>{rootPath}</code></li>
                <li>Escritura: solo este workspace</li>
                <li>Comandos: permitidos</li>
                <li>Red: habilitada</li>
                <li>Expira: <time dateTime={actTask.expiresAt}>{new Date(actTask.expiresAt).toLocaleString()}</time></li>
              </ul>
              <div className="approval-actions">
                <button type="button" onClick={() => void cancelActTask()}><X aria-hidden="true" size={12} /> Cancelar</button>
                <button className="approve" type="button" disabled={!workspaceReady} onClick={() => void approveActTask()}><Check aria-hidden="true" size={12} /> Aprobar turno</button>
              </div>
            </div>
          ) : (
            <div className={`act-progress act-progress--${actTask.status}`}>
              <div><span className="act-status-dot" /><strong>{actTask.status === "running" ? "Codex está trabajando" : actTask.status === "cancelling" ? "Cancelación solicitada" : actTask.status === "completed" ? "Tarea completada" : actTask.status}</strong></div>
              <p className="act-scope-root"><strong>Raíz:</strong> <code>{rootPath}</code></p>
              <p>{actTask.output.at(-1) ?? "Esperando eventos del agente…"}</p>
              {actTask.status === "running" ? <button type="button" onClick={() => void cancelActTask()}>Cancelar</button> : null}
              {actTask.status === "completed" || actTask.status === "cancelled" || actTask.status === "failed" ? (
                <button type="button" onClick={resetActTask}>Nueva tarea</button>
              ) : null}
            </div>
          )}
        </div>
      )}
    </PanelFrame>
  );
});
