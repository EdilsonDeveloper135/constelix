import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SemanticNodeContextMenu } from "./SemanticNodeContextMenu";
import type { SemanticFlowNode } from "../../types";

function node(id: string, label: string): SemanticFlowNode {
  return {
    id,
    type: "semantic",
    position: { x: 0, y: 0 },
    data: { kind: "function", label },
  };
}

function baseProps(pathFindingSourceId: string | null) {
  return {
    node: node("node-a", "handler"),
    x: 100,
    y: 100,
    pathFindingSourceId,
    onClose: vi.fn(),
    onInspect: vi.fn(),
    onActivate: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenTerminal: vi.fn(),
    onSetPathSource: vi.fn(),
    onFindPath: vi.fn(),
  };
}

describe("SemanticNodeContextMenu path-finding item", () => {
  it("offers to mark this node as the path source when nothing is marked yet", async () => {
    const user = userEvent.setup();
    const props = baseProps(null);
    render(<SemanticNodeContextMenu {...props} />);

    const item = screen.getByRole("menuitem", {
      name: "Marcar como origen de ruta",
    });
    expect(item).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /Buscar ruta/ }),
    ).not.toBeInTheDocument();

    await user.click(item);
    expect(props.onSetPathSource).toHaveBeenCalledTimes(1);
    expect(props.onFindPath).not.toHaveBeenCalled();
  });

  it("offers to cancel the source when this node is the one currently marked", async () => {
    const user = userEvent.setup();
    const props = baseProps("node-a");
    render(<SemanticNodeContextMenu {...props} />);

    const item = screen.getByRole("menuitem", {
      name: "Cancelar origen de ruta",
    });
    await user.click(item);
    expect(props.onSetPathSource).toHaveBeenCalledTimes(1);
  });

  it("offers to find the path once a different node is marked as the source", async () => {
    const user = userEvent.setup();
    const props = baseProps("node-elsewhere");
    render(<SemanticNodeContextMenu {...props} />);

    expect(
      screen.queryByRole("menuitem", { name: /Marcar como origen/ }),
    ).not.toBeInTheDocument();
    const item = screen.getByRole("menuitem", {
      name: "Buscar ruta desde el origen marcado",
    });
    await user.click(item);
    expect(props.onFindPath).toHaveBeenCalledTimes(1);
    expect(props.onSetPathSource).not.toHaveBeenCalled();
  });
});
