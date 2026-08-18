import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SemanticFlowNode } from "../../types";

vi.mock("../../lib/api", () => ({
  apiClient: { saveLayout: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../../lib/layout", () => ({
  layoutSemanticNodes: vi.fn().mockResolvedValue({}),
  resolveSemanticLayoutCollisions: vi.fn(
    (_nodes: unknown, proposed: Record<string, { x: number; y: number }>) =>
      proposed,
  ),
}));

let useWorkspaceStore: typeof import("../../store/useWorkspaceStore")["useWorkspaceStore"];
let CanvasFilters: typeof import("./CanvasFilters")["CanvasFilters"];

function semanticNode(id: string, relativePath: string): SemanticFlowNode {
  return {
    id,
    type: "semantic",
    position: { x: 0, y: 0 },
    data: {
      kind: "file",
      label: relativePath,
      relativePath,
    },
  } as SemanticFlowNode;
}

beforeEach(async () => {
  ({ useWorkspaceStore } = await import("../../store/useWorkspaceStore"));
  ({ CanvasFilters } = await import("./CanvasFilters"));
  const initial = useWorkspaceStore.getInitialState();
  useWorkspaceStore.setState(
    {
      ...initial,
      nodes: [
        semanticNode("file-a", "src/index.ts"),
        semanticNode("file-b", "src/app.py"),
      ],
      canvasFilters: { nodeKind: "all", extension: "all" },
    },
    true,
  );
});

describe("CanvasFilters", () => {
  it("starts collapsed and reveals filter controls once expanded", async () => {
    const user = userEvent.setup();
    render(<CanvasFilters evidenceOverrides={0} />);

    expect(screen.queryByLabelText("Filtrar por tipo de nodo")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Filtros/ }));

    expect(screen.getByLabelText("Filtrar por tipo de nodo")).toBeInTheDocument();
    expect(screen.getByLabelText("Filtrar por extensión")).toBeInTheDocument();
  });

  it("lists extensions derived from the current nodes", async () => {
    const user = userEvent.setup();
    render(<CanvasFilters evidenceOverrides={0} />);
    await user.click(screen.getByRole("button", { name: /Filtros/ }));

    const extensionSelect = screen.getByLabelText("Filtrar por extensión");
    expect(extensionSelect).toHaveTextContent(".ts");
    expect(extensionSelect).toHaveTextContent(".py");
  });

  it("disables reset until a filter is active, then clears both filters on click", async () => {
    const user = userEvent.setup();
    render(<CanvasFilters evidenceOverrides={0} />);
    await user.click(screen.getByRole("button", { name: /Filtros/ }));

    const resetButton = screen.getByLabelText("Restablecer filtros");
    expect(resetButton).toBeDisabled();

    await user.selectOptions(
      screen.getByLabelText("Filtrar por tipo de nodo"),
      "file",
    );
    expect(useWorkspaceStore.getState().canvasFilters.nodeKind).toBe("file");
    expect(resetButton).toBeEnabled();

    await user.click(resetButton);
    expect(useWorkspaceStore.getState().canvasFilters).toEqual({
      nodeKind: "all",
      extension: "all",
    });
  });

  it("shows the evidence-override notice only while expanded", async () => {
    const user = userEvent.setup();
    render(<CanvasFilters evidenceOverrides={2} />);

    expect(
      screen.queryByText(/fuera del filtro/),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Filtros/ }));
    expect(screen.getByText("La evidencia muestra 2 nodos fuera del filtro.")).toBeInTheDocument();
  });
});
