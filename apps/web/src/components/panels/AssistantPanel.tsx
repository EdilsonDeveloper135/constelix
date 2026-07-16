import { AlertTriangle, Bot, Check, Copy, Play, Send, ShieldCheck, Sparkles, Square, X } from "lucide-react";
import { memo, useMemo } from "react";
import type { NodeProps } from "@xyflow/react";

import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import type { AssistantFlowNode, SemanticFlowNode } from "../../types";
import { PanelFrame } from "./PanelFrame";

export const AssistantPanel = memo(function AssistantPanel({ id, data, height }: NodeProps<AssistantFlowNode>) {
  const mode = useWorkspaceStore((state) => state.assistantMode);
  const setMode = useWorkspaceStore((state) => state.setAssistantMode);
  const question = useWorkspaceStore((state) => state.question);
  const setQuestion = useWorkspaceStore((state) => state.setQuestion);
  const answer = useWorkspaceStore((state) => state.answer);
  const error = useWorkspaceStore((state) => state.assistantError);
  const thinking = useWorkspaceStore((state) => state.assistantThinking);
  const evidencePath = useWorkspaceStore((state) => state.evidencePath);
  const nodes = useWorkspaceStore((state) => state.nodes);
  const submitQuestion = useWorkspaceStore((state) => state.submitQuestion);
  const cancelQuestion = useWorkspaceStore((state) => state.cancelQuestion);
  const navigateEvidence = useWorkspaceStore((state) => state.navigateEvidence);
  const actTask = useWorkspaceStore((state) => state.actTask);
  const actAvailable = useWorkspaceStore((state) => state.actAvailable);
  const codexReason = useWorkspaceStore((state) => state.codexReason);
  const createActTask = useWorkspaceStore((state) => state.createActTask);
  const approveActTask = useWorkspaceStore((state) => state.approveActTask);
  const cancelActTask = useWorkspaceStore((state) => state.cancelActTask);

  const evidenceLabels = useMemo(() => {
    if (!evidencePath) return [];
    const labels = new Map(
      nodes
        .filter((node): node is SemanticFlowNode => node.type === "semantic")
        .map((node) => [node.id, node.data.label])
    );
    return evidencePath.nodeIds.map((nodeId) => ({ id: nodeId, label: labels.get(nodeId) ?? nodeId }));
  }, [evidencePath, nodes]);

  return (
    <PanelFrame
      id={id}
      title={data.title}
      icon={<Sparkles aria-hidden="true" size={14} />}
      minWidth={480}
      minHeight={180}
      currentHeight={height}
      accent="violet"
      className="assistant-panel"
    >
      <div className="assistant-tabs" role="tablist" aria-label="Modo de inteligencia artificial">
        <button type="button" role="tab" aria-selected={mode === "ask"} className={mode === "ask" ? "active" : ""} onClick={() => setMode("ask")}>
          <Bot aria-hidden="true" size={13} /> Preguntar
        </button>
        <button type="button" role="tab" aria-selected={mode === "act"} className={mode === "act" ? "active" : ""} onClick={() => setMode("act")}>
          <Play aria-hidden="true" size={12} /> Actuar
        </button>
      </div>

      {mode === "ask" ? (
        <div className="ask-layout" data-testid="ask-panel">
          <div className="ask-question-column">
            <label htmlFor="constelix-question">Pregunta</label>
            <textarea
              id="constelix-question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submitQuestion();
                }
              }}
              placeholder="Pregunta sobre el proyecto…"
            />
            <div className="ask-submit-row">
              <span>⌘ ↵ para enviar</span>
              <button type="button" disabled={!thinking && !question.trim()} onClick={() => thinking ? cancelQuestion() : void submitQuestion()}>
                {thinking ? <Square aria-hidden="true" size={11} /> : <Send aria-hidden="true" size={12} />}
                {thinking ? "Detener" : "Consultar"}
              </button>
            </div>
          </div>
          <div className="ask-answer-column" aria-live="polite">
            <div className="ask-answer-heading">
              <span>Respuesta</span>
              {answer ? <button type="button" aria-label="Copiar respuesta" onClick={() => void navigator.clipboard.writeText(answer)}><Copy aria-hidden="true" size={12} /></button> : null}
            </div>
            {thinking && !answer ? <div className="answer-thinking"><span /><span /><span /> Consultando el grafo…</div> : null}
            {error ? <p className="assistant-error">{error}</p> : null}
            {answer ? <p className="answer-copy">{answer}</p> : !thinking && !error ? <p className="answer-placeholder">La respuesta mostrará evidencia verificable del grafo.</p> : null}
            {evidenceLabels.length ? (
              <div className="evidence-path" aria-label="Recorrido de evidencia">
                {evidenceLabels.map((item, index) => (
                  <span key={item.id}>
                    <button type="button" onClick={() => void navigateEvidence(item.id)}>{item.label}</button>
                    {index < evidenceLabels.length - 1 ? <i aria-hidden="true">→</i> : null}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="act-layout" data-testid="act-panel">
          {!actAvailable ? (
            <div className="act-unavailable"><AlertTriangle aria-hidden="true" size={18} /><div><strong>Codex local no disponible</strong><p>{codexReason ?? "Instala o actualiza Codex CLI para habilitar este modo."}</p></div></div>
          ) : actTask === null ? (
            <>
              <div className="act-copy">
                <ShieldCheck aria-hidden="true" size={24} />
                <div><strong>Delegación con aprobación</strong><p>Codex podrá escribir y ejecutar comandos dentro del workspace. La red estará habilitada; las rutas externas permanecen bloqueadas.</p></div>
              </div>
              <button className="act-primary" type="button" disabled={!question.trim()} onClick={() => void createActTask()}>Preparar tarea</button>
            </>
          ) : actTask.status === "awaitingApproval" ? (
            <div className="approval-card">
              <div><AlertTriangle aria-hidden="true" size={17} /><strong>Revisa antes de aprobar</strong></div>
              <p>{actTask.objective}</p>
              <ul><li>Escritura: solo este workspace</li><li>Comandos: permitidos</li><li>Red: habilitada</li></ul>
              <div className="approval-actions">
                <button type="button" onClick={() => void cancelActTask()}><X aria-hidden="true" size={12} /> Cancelar</button>
                <button className="approve" type="button" onClick={() => void approveActTask()}><Check aria-hidden="true" size={12} /> Aprobar turno</button>
              </div>
            </div>
          ) : (
            <div className={`act-progress act-progress--${actTask.status}`}>
              <div><span className="act-status-dot" /><strong>{actTask.status === "running" ? "Codex está trabajando" : actTask.status === "completed" ? "Tarea completada" : actTask.status}</strong></div>
              <p>{actTask.output.at(-1) ?? "Esperando eventos del agente…"}</p>
              {actTask.status === "running" ? <button type="button" onClick={() => void cancelActTask()}>Cancelar</button> : null}
            </div>
          )}
        </div>
      )}
    </PanelFrame>
  );
});
