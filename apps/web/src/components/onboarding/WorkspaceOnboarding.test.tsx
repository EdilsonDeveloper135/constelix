import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
let useShellStore: typeof import("../../store/useShellStore")["useShellStore"];
let WorkspaceOnboarding: typeof import("./WorkspaceOnboarding")["WorkspaceOnboarding"];

beforeEach(async () => {
  ({ useWorkspaceStore } = await import("../../store/useWorkspaceStore"));
  ({ useShellStore } = await import("../../store/useShellStore"));
  ({ WorkspaceOnboarding } = await import("./WorkspaceOnboarding"));

  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
  useWorkspaceStore.setState({
    demoMode: false,
    remoteHydrated: false,
    connection: "connecting",
    index: {
      phase: "scanning",
      progress: 0.4,
      filesIndexed: 12,
      symbolsIndexed: 34,
      edgesIndexed: 5,
    },
  });
  useShellStore.setState({ onboardingOpen: true });
});

describe("WorkspaceOnboarding", () => {
  it("renders nothing in demo mode", () => {
    useWorkspaceStore.setState({ demoMode: true });
    render(<WorkspaceOnboarding />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders nothing once the user has dismissed it", () => {
    useShellStore.setState({ onboardingOpen: false });
    render(<WorkspaceOnboarding />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows indexing progress while the workspace is still validating", () => {
    render(<WorkspaceOnboarding />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "40",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("disables Skip and the tour button until the workspace hydrates", () => {
    render(<WorkspaceOnboarding />);
    expect(screen.getByRole("button", { name: "Omitir" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Iniciar recorrido/ }),
    ).toBeDisabled();
  });

  it("enables Skip and closes onboarding once clicked, after hydration", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({ remoteHydrated: true, connection: "connected" });
    render(<WorkspaceOnboarding />);

    const skip = screen.getByRole("button", { name: "Omitir" });
    expect(skip).toBeEnabled();
    await user.click(skip);

    expect(useShellStore.getState().onboardingOpen).toBe(false);
  });

  it("shows a retry affordance instead of progress when the bootstrap stalls, and retrying calls reconcileGraph", async () => {
    const user = userEvent.setup();
    const reconcileGraph = vi.fn().mockResolvedValue(undefined);
    useWorkspaceStore.setState({
      remoteHydrated: false,
      connection: "degraded",
      assistantError: "El agente respondió con un error 503.",
      reconcileGraph,
    });
    render(<WorkspaceOnboarding />);

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("El agente respondió con un error 503.");

    await user.click(screen.getByRole("button", { name: /Reintentar/ }));
    expect(reconcileGraph).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape via the shared focus trap", async () => {
    const user = userEvent.setup();
    render(<WorkspaceOnboarding />);
    screen.getByRole("dialog").focus();

    await user.keyboard("{Escape}");
    expect(useShellStore.getState().onboardingOpen).toBe(false);
  });
});
