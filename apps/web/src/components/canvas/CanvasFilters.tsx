import { Filter, RotateCcw } from "lucide-react";
import { memo, useMemo } from "react";

import {
  availableExtensions,
  FILTERABLE_NODE_KINDS,
} from "../../lib/canvasFilters";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import type { SemanticNodeKind } from "../../types";

const kindLabels: Record<SemanticNodeKind, string> = {
  workspace: "Proyecto",
  directory: "Carpetas",
  file: "Archivos",
  module: "Módulos",
  class: "Clases",
  interface: "Interfaces",
  function: "Funciones",
  method: "Métodos",
  route: "Rutas",
  service: "Servicios",
  external: "Dependencias externas",
};

interface CanvasFiltersProps {
  evidenceOverrides: number;
}

export const CanvasFilters = memo(function CanvasFilters({
  evidenceOverrides,
}: CanvasFiltersProps) {
  const filters = useWorkspaceStore((state) => state.canvasFilters);
  const semanticVersion = useWorkspaceStore((state) => state.semanticVersion);
  const setNodeKindFilter = useWorkspaceStore(
    (state) => state.setNodeKindFilter,
  );
  const setExtensionFilter = useWorkspaceStore(
    (state) => state.setExtensionFilter,
  );
  const resetCanvasFilters = useWorkspaceStore(
    (state) => state.resetCanvasFilters,
  );
  const extensions = useMemo(
    () => availableExtensions(useWorkspaceStore.getState().nodes),
    [semanticVersion],
  );
  const active =
    filters.nodeKind !== "all" || filters.extension !== "all";

  return (
    <section className="canvas-filters" aria-label="Filtros del grafo">
      <span className="canvas-filter-title">
        <Filter aria-hidden="true" size={12} />
        Vista
      </span>
      <label>
        Tipo
        <select
          aria-label="Filtrar por tipo de nodo"
          value={filters.nodeKind}
          onChange={(event) =>
            setNodeKindFilter(
              event.target.value as typeof filters.nodeKind,
            )
          }
        >
          <option value="all">Todos</option>
          {FILTERABLE_NODE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kindLabels[kind]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Extensión
        <select
          aria-label="Filtrar por extensión"
          value={filters.extension}
          onChange={(event) => setExtensionFilter(event.target.value)}
        >
          <option value="all">Todas</option>
          {extensions.map((extension) => (
            <option key={extension} value={extension}>
              {extension}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        aria-label="Restablecer filtros"
        disabled={!active}
        onClick={resetCanvasFilters}
      >
        <RotateCcw aria-hidden="true" size={12} />
      </button>
      {evidenceOverrides > 0 ? (
        <span className="canvas-filter-evidence" role="status">
          La evidencia muestra {evidenceOverrides} nodo
          {evidenceOverrides === 1 ? "" : "s"} fuera del filtro.
        </span>
      ) : null}
    </section>
  );
});
