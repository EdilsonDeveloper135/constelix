import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReactFlowProvider, Position, type NodeProps } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SemanticNode } from "./SemanticNode";
import type { SemanticFlowNode, SemanticNodeData } from "../../types";

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

beforeEach(async () => {
  ({ useWorkspaceStore } = await import("../../store/useWorkspaceStore"));
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
  useWorkspaceStore.setState({ compactMode: false });
});

function nodeProps(
  data: SemanticNodeData,
  overrides: Partial<NodeProps<SemanticFlowNode>> = {},
): NodeProps<SemanticFlowNode> {
  return {
    id: "node-1",
    data,
    selected: false,
    type: "semantic",
    dragging: false,
    isConnectable: true,
    zIndex: 0,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    targetPosition: Position.Top,
    sourcePosition: Position.Bottom,
    ...overrides,
  } as NodeProps<SemanticFlowNode>;
}

function renderSemanticNode(
  data: SemanticNodeData,
  overrides: Partial<NodeProps<SemanticFlowNode>> = {},
) {
  return render(
    <ReactFlowProvider>
      <SemanticNode {...nodeProps(data, overrides)} />
    </ReactFlowProvider>,
  );
}

describe("SemanticNode", () => {
  it("renders the label, detail, and an accessible kind+label group name", () => {
    renderSemanticNode({
      kind: "function",
      label: "healthcheck",
      detail: "apps/api/health.ts",
    });

    expect(screen.getByText("healthcheck")).toBeInTheDocument();
    expect(screen.getByText("apps/api/health.ts")).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "function: healthcheck" }),
    ).toBeInTheDocument();
  });

  it("shows expand/collapse and terminal actions for hierarchy nodes, and activates on double-click", async () => {
    const user = userEvent.setup();
    const activateSemanticNode = vi.fn().mockResolvedValue(undefined);
    useWorkspaceStore.setState({ activateSemanticNode });
    renderSemanticNode({
      kind: "directory",
      label: "src",
      relativePath: "apps/web/src",
      collapsed: true,
    });

    const expandButton = screen.getByRole("button", { name: "Expandir src" });
    expect(expandButton).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Abrir terminal en src" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /en editor/ }),
    ).not.toBeInTheDocument();

    await user.click(expandButton);
    expect(activateSemanticNode).toHaveBeenCalledWith("node-1");

    await user.dblClick(screen.getByRole("group"));
    expect(activateSemanticNode).toHaveBeenCalledTimes(2);
  });

  it("shows an 'open in editor' action for file-like nodes with a path, and wires it to openFile", async () => {
    const user = userEvent.setup();
    const openFile = vi.fn();
    useWorkspaceStore.setState({ openFile });
    renderSemanticNode({
      kind: "file",
      label: "health.ts",
      relativePath: "apps/api/health.ts",
    });

    const openButton = screen.getByRole("button", {
      name: "Abrir health.ts en editor",
    });
    await user.click(openButton);
    expect(openFile).toHaveBeenCalledWith("apps/api/health.ts", "node-1");
    expect(
      screen.queryByRole("button", { name: /terminal/ }),
    ).not.toBeInTheDocument();
  });

  it("hides detail text and the action row in compact mode", () => {
    useWorkspaceStore.setState({ compactMode: true });
    renderSemanticNode({
      kind: "directory",
      label: "src",
      detail: "12 archivos",
    });

    expect(screen.queryByText("12 archivos")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("marks the current evidence-path step for assistive tech", () => {
    renderSemanticNode({
      kind: "function",
      label: "healthcheck",
      evidenceState: "current",
    });

    expect(screen.getByRole("group")).toHaveAttribute("aria-current", "step");
  });
});
