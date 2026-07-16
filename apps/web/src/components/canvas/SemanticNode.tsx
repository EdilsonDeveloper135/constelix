import {
  Bot,
  Box,
  Braces,
  FunctionSquare,
  FileCode2,
  Folder,
  Network,
  Package,
  Route
} from "lucide-react";
import { memo, type ComponentType } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

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

export const SemanticNode = memo(function SemanticNode({ data, selected }: NodeProps<SemanticFlowNode>) {
  const Icon = icons[data.kind];
  const evidenceClass = data.evidenceState ? ` semantic-node--evidence-${data.evidenceState}` : "";

  return (
    <article
      className={`semantic-node semantic-node--${data.kind}${selected ? " semantic-node--selected" : ""}${evidenceClass}`}
      aria-label={`${data.kind}: ${data.label}`}
      title={data.relativePath ?? data.label}
    >
      <Handle type="target" position={Position.Top} className="semantic-handle" />
      <div className="semantic-icon"><Icon aria-hidden={true} size={17} /></div>
      <div className="semantic-copy">
        <strong>{data.label}</strong>
        {data.detail ? <span>{data.detail}</span> : null}
      </div>
      {data.health === "healthy" ? <span className="semantic-health" aria-label="Servicio activo" /> : null}
      <Handle type="source" position={Position.Bottom} className="semantic-handle" />
    </article>
  );
});
