import { Bot, Box, ChevronUp, FileCode2, Folder, FunctionSquare, Package, Route } from "lucide-react";
import { memo, useState } from "react";

const nodeItems = [
  { label: "Carpeta", icon: Folder, tone: "folder" },
  { label: "Archivo", icon: FileCode2, tone: "file" },
  { label: "Módulo", icon: Package, tone: "module" },
  { label: "Clase", icon: Box, tone: "class" },
  { label: "Función", icon: FunctionSquare, tone: "function" },
  { label: "Ruta API", icon: Route, tone: "route" },
  { label: "Servicio (agente)", icon: Bot, tone: "service" }
] as const;

const edgeItems = [
  { label: "contiene", tone: "contains" },
  { label: "importa", tone: "imports" },
  { label: "llama", tone: "calls" },
  { label: "expone", tone: "exports" },
  { label: "ejecuta", tone: "executes" }
] as const;

export const Legend = memo(function Legend() {
  const [expanded, setExpanded] = useState(false);
  return (
    <aside className={`canvas-legend${expanded ? " canvas-legend--expanded" : ""}`} aria-label="Leyenda del grafo">
      <button
        className="canvas-legend__toggle"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        Leyenda <ChevronUp aria-hidden="true" size={13} />
      </button>
      {expanded ? <div className="canvas-legend__content"><div className="legend-node-list">
        {nodeItems.map((item) => {
          const Icon = item.icon;
          return <span key={item.label} className={`legend-node legend-node--${item.tone}`}><Icon aria-hidden={true} size={14} />{item.label}</span>;
        })}
      </div>
      <div className="legend-divider" />
      <div className="legend-edge-list">
        {edgeItems.map((item) => <span key={item.label}><i className={`legend-line legend-line--${item.tone}`} />{item.label}</span>)}
      </div>
      </div> : null}
    </aside>
  );
});
