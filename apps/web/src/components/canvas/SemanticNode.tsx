import {
  Bot,
  Box,
  Braces,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FunctionSquare,
  FileCode2,
  Folder,
  Network,
  Package,
  Route,
  SquareTerminal,
} from "lucide-react";
import { memo, type ComponentType } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import type { SemanticFlowNode, SemanticNodeKind } from "../../types";

const icons: Record<SemanticNodeKind, ComponentType<{ size?: number; "aria-hidden"?: boolean }>> = {
  workspace: Network,
  directory: Folder,
  file: FileCode2,
  module: Package,
  class: Box,
  interface: Braces,
  function: FunctionSquare,
  method: FunctionSquare,
  route: Route,
  service: Bot,
  external: Package
};

function cwdForNode(data: SemanticFlowNode["data"]): string {
  const path = data.relativePath ?? ".";
  if (data.kind !== "module") return path;
  const parts = path.split("/");
  parts.pop();
  return parts.join("/") || ".";
}

export const SemanticNode = memo(function SemanticNode({
  id,
  data,
  selected,
}: NodeProps<SemanticFlowNode>) {
  const compactMode = useWorkspaceStore((state) => state.compactMode);
  const activateSemanticNode = useWorkspaceStore(
    (state) => state.activateSemanticNode,
  );
  const openFile = useWorkspaceStore((state) => state.openFile);
  const openTerminal = useWorkspaceStore((state) => state.openTerminal);
  const Icon = icons[data.kind];
  const evidenceClass = data.evidenceState ? ` semantic-node--evidence-${data.evidenceState}` : "";
  const hierarchy =
    data.kind === "workspace" ||
    data.kind === "directory" ||
    data.kind === "module";
  const canOpenFile =
    Boolean(data.relativePath) &&
    data.kind !== "workspace" &&
    data.kind !== "directory";

  return (
    <article
      className={`semantic-node semantic-node--${data.kind}${selected ? " semantic-node--selected" : ""}${compactMode ? " semantic-node--compact" : ""}${evidenceClass}`}
      aria-label={`${data.kind}: ${data.label}`}
      title={data.relativePath ?? data.label}
      data-expanded={data.expanded ? "true" : "false"}
      onDoubleClick={(event) => {
        event.stopPropagation();
        void activateSemanticNode(id);
      }}
    >
      <Handle type="target" position={Position.Top} className="semantic-handle" />
      <div className="semantic-icon"><Icon aria-hidden={true} size={17} /></div>
      <div className="semantic-copy">
        <strong>{data.label}</strong>
        {!compactMode && data.detail ? <span>{data.detail}</span> : null}
      </div>
      {!compactMode && (data.childCount || data.hasMore) ? (
        <span className="semantic-count" aria-label={`${data.childCount ?? 0} elementos relacionados`}>
          {data.childCount ?? 0}{data.hasMore ? "+" : ""}
        </span>
      ) : null}
      {!compactMode ? (
        <div className="semantic-actions nodrag">
          {hierarchy ? (
            <button
              type="button"
              aria-label={data.collapsed ? `Expandir ${data.label}` : `Explorar o contraer ${data.label}`}
              onClick={(event) => {
                event.stopPropagation();
                void activateSemanticNode(id);
              }}
            >
              {data.collapsed ? <ChevronRight aria-hidden="true" size={12} /> : <ChevronDown aria-hidden="true" size={12} />}
            </button>
          ) : null}
          {canOpenFile ? (
            <button
              type="button"
              aria-label={`Abrir ${data.label} en editor`}
              onClick={(event) => {
                event.stopPropagation();
                openFile(data.relativePath!, id);
              }}
            >
              <ExternalLink aria-hidden="true" size={11} />
            </button>
          ) : null}
          {hierarchy ? (
            <button
              type="button"
              aria-label={`Abrir terminal en ${data.label}`}
              onClick={(event) => {
                event.stopPropagation();
                openTerminal(cwdForNode(data), id);
              }}
            >
              <SquareTerminal aria-hidden="true" size={11} />
            </button>
          ) : null}
        </div>
      ) : null}
      {data.health === "healthy" ? <span className="semantic-health" aria-label="Servicio activo" /> : null}
      <Handle type="source" position={Position.Bottom} className="semantic-handle" />
    </article>
  );
});
