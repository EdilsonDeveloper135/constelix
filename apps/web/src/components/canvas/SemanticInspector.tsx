import {
  ArrowDownLeft,
  ArrowUpRight,
  Code2,
  Link2,
  MessageSquareText,
  X,
} from "lucide-react";
import { memo, useMemo } from "react";

import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import type { GraphRelation, SemanticFlowNode } from "../../types";

interface RelatedNode {
  edgeId: string;
  relation: GraphRelation;
  node: SemanticFlowNode;
}

export const SemanticInspector = memo(function SemanticInspector() {
  const activeTool = useWorkspaceStore((state) => state.activeTool);
  const selectedNodeId = useWorkspaceStore((state) => state.selectedNodeId);
  const nodes = useWorkspaceStore((state) => state.nodes);
  const edges = useWorkspaceStore((state) => state.edges);
  const selectNode = useWorkspaceStore((state) => state.selectNode);
  const openFile = useWorkspaceStore((state) => state.openFile);
  const setQuestion = useWorkspaceStore((state) => state.setQuestion);
  const setAssistantMode = useWorkspaceStore((state) => state.setAssistantMode);
  const setActiveTool = useWorkspaceStore((state) => state.setActiveTool);

  const selectedNode = useMemo(
    () =>
      nodes.find(
        (node): node is SemanticFlowNode =>
          node.id === selectedNodeId && node.type === "semantic",
      ),
    [nodes, selectedNodeId],
  );
  const relations = useMemo(() => {
    if (!selectedNode) return { incoming: [], outgoing: [] };
    const nodeById = new Map(
      nodes
        .filter((node): node is SemanticFlowNode => node.type === "semantic")
        .map((node) => [node.id, node]),
    );
    const incoming: RelatedNode[] = [];
    const outgoing: RelatedNode[] = [];
    for (const edge of edges) {
      if (edge.target === selectedNode.id) {
        const node = nodeById.get(edge.source);
        if (node) incoming.push({ edgeId: edge.id, relation: edge.data?.relation ?? "calls", node });
      }
      if (edge.source === selectedNode.id) {
        const node = nodeById.get(edge.target);
        if (node) outgoing.push({ edgeId: edge.id, relation: edge.data?.relation ?? "calls", node });
      }
    }
    return { incoming, outgoing };
  }, [edges, nodes, selectedNode]);

  if (!selectedNode || activeTool !== "map") return null;
  const relativePath = selectedNode.data.relativePath;

  const askAboutNode = () => {
    setQuestion(
      `Explica el papel de ${selectedNode.data.label}, sus relaciones principales y la evidencia relevante del código.`,
    );
    setAssistantMode("ask");
    setActiveTool("ai");
  };

  return (
    <aside
      className="semantic-inspector"
      aria-label={`Detalles de ${selectedNode.data.label}`}
      data-testid="semantic-inspector"
    >
      <header className="semantic-inspector__header">
        <span><Link2 aria-hidden="true" size={17} /></span>
        <div>
          <strong>{selectedNode.data.label}</strong>
          <small>{semanticKindLabel(selectedNode.data.kind)}</small>
        </div>
        <button type="button" aria-label="Cerrar detalles" onClick={() => selectNode(null)}>
          <X aria-hidden="true" size={16} />
        </button>
      </header>

      <div className="semantic-inspector__summary">
        {relativePath ? <code title={relativePath}>{relativePath}</code> : null}
        {selectedNode.data.detail ? <p>{selectedNode.data.detail}</p> : null}
        <dl>
          <div><dt>Entrantes</dt><dd>{relations.incoming.length}</dd></div>
          <div><dt>Salientes</dt><dd>{relations.outgoing.length}</dd></div>
          {selectedNode.data.language ? <div><dt>Lenguaje</dt><dd>{selectedNode.data.language}</dd></div> : null}
        </dl>
      </div>

      <RelationList
        title="Relaciones entrantes"
        icon="incoming"
        relations={relations.incoming}
        onSelect={selectNode}
      />
      <RelationList
        title="Relaciones salientes"
        icon="outgoing"
        relations={relations.outgoing}
        onSelect={selectNode}
      />

      <footer className="semantic-inspector__actions">
        <button
          type="button"
          disabled={!relativePath}
          onClick={() => relativePath && openFile(relativePath, selectedNode.id)}
        >
          <Code2 aria-hidden="true" size={16} /> Abrir código
        </button>
        <button type="button" onClick={askAboutNode}>
          <MessageSquareText aria-hidden="true" size={16} /> Preguntar sobre esto
        </button>
      </footer>
    </aside>
  );
});

function RelationList({
  title,
  icon,
  relations,
  onSelect,
}: {
  title: string;
  icon: "incoming" | "outgoing";
  relations: RelatedNode[];
  onSelect: (id: string) => void;
}) {
  const Icon = icon === "incoming" ? ArrowDownLeft : ArrowUpRight;
  return (
    <section className="semantic-inspector__relations">
      <h3><Icon aria-hidden="true" size={14} /> {title} <span>{relations.length}</span></h3>
      {relations.length ? (
        <div>
          {relations.slice(0, 6).map(({ edgeId, relation, node }) => (
            <button key={edgeId} type="button" onClick={() => onSelect(node.id)}>
              <span><strong>{node.data.label}</strong><small>{node.data.relativePath ?? semanticKindLabel(node.data.kind)}</small></span>
              <em>{relationLabel(relation)}</em>
            </button>
          ))}
        </div>
      ) : <p>Sin relaciones visibles en la página actual.</p>}
    </section>
  );
}

function semanticKindLabel(kind: SemanticFlowNode["data"]["kind"]): string {
  const labels: Record<SemanticFlowNode["data"]["kind"], string> = {
    workspace: "Workspace",
    directory: "Directorio",
    file: "Archivo",
    module: "Módulo",
    class: "Clase",
    interface: "Interfaz",
    function: "Función",
    method: "Método",
    route: "Ruta",
    service: "Servicio",
    external: "Dependencia externa",
  };
  return labels[kind];
}

function relationLabel(relation: GraphRelation): string {
  const labels: Record<GraphRelation, string> = {
    contains: "contiene",
    imports: "importa",
    exports: "exporta",
    extends: "extiende",
    implements: "implementa",
    calls: "llama",
  };
  return labels[relation];
}
