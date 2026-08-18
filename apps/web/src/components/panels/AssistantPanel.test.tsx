import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReactFlowProvider } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AssistantPanelData } from "../../types";

vi.mock("../../lib/api", () => ({
  apiClient: {
    hasToken: false,
    subscribe: vi.fn(() => () => {}),
    subscribeConnection: vi.fn(() => () => {}),
    subscribeWorkspaceReconciliation: vi.fn(() => () => {}),
    connect: vi.fn(() => () => {}),
    saveLayout: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../lib/layout", () => ({
  layoutSemanticNodes: vi.fn().mockResolvedValue({}),
  resolveSemanticLayoutCollisions: vi.fn(
    (_nodes: unknown, proposed: Record<string, { x: number; y: number }>) =>
      proposed,
  ),
}));

let useWorkspaceStore: typeof import("../../store/useWorkspaceStore")["useWorkspaceStore"];
let AssistantPanel: typeof import("./AssistantPanel")["AssistantPanel"];

beforeEach(async () => {
  ({ useWorkspaceStore } = await import("../../store/useWorkspaceStore"));
  ({ AssistantPanel } = await import("./AssistantPanel"));
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
});

function renderAssistantPanel() {
  const data: AssistantPanelData = {
    panelType: "assistant",
    dock: "floating",
    title: "Constelix",
    mode: "ask",
  };
  return render(
    <ReactFlowProvider>
      <AssistantPanel id="panel-assistant" data={data} height={320} />
    </ReactFlowProvider>,
  );
}

describe("AssistantPanel", () => {
  it("keeps an unsent Ask question from leaking into the Act objective, and vice versa", async () => {
    const user = userEvent.setup();
    renderAssistantPanel();

    const question = await screen.findByLabelText("Pregunta");
    await user.clear(question);
    await user.type(question, "¿Qué archivos exponen la API pública?");

    await user.click(screen.getByRole("tab", { name: "Actuar" }));
    const objective = await screen.findByLabelText("Objetivo del turno");
    expect(objective).toHaveValue("");

    await user.type(objective, "Añade un endpoint de salud");

    await user.click(screen.getByRole("tab", { name: "Preguntar" }));
    const questionAgain = await screen.findByLabelText("Pregunta");
    expect(questionAgain).toHaveValue("¿Qué archivos exponen la API pública?");

    await user.click(screen.getByRole("tab", { name: "Actuar" }));
    const objectiveAgain = await screen.findByLabelText("Objetivo del turno");
    expect(objectiveAgain).toHaveValue("Añade un endpoint de salud");
  });

  it("disables sending an empty Act objective and enables it once text is entered", async () => {
    const user = userEvent.setup();
    renderAssistantPanel();

    await user.click(screen.getByRole("tab", { name: "Actuar" }));
    const prepareButton = await screen.findByRole("button", {
      name: "Preparar tarea",
    });
    expect(prepareButton).toBeDisabled();

    const objective = screen.getByLabelText("Objetivo del turno");
    await user.type(objective, "Refactoriza el módulo de autenticación");
    expect(prepareButton).toBeEnabled();
  });
});
