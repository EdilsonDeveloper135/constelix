import { StrictMode } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TerminalFlowNode } from "../../types";

const apiMock = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  deleteTerminal: vi.fn(),
  readTerminalOutput: vi.fn(),
  sendEvent: vi.fn(),
  saveLayout: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  apiClient: apiMock,
}));

vi.mock("../../lib/layout", () => ({
  layoutSemanticNodes: vi.fn().mockResolvedValue({}),
  resolveSemanticLayoutCollisions: vi.fn(
    (_nodes: unknown, proposed: Record<string, { x: number; y: number }>) =>
      proposed,
  ),
}));

const terminalInstances = vi.hoisted(
  () =>
    [] as Array<{
      open: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
      writeln: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
      clear: ReturnType<typeof vi.fn>;
      onData: ReturnType<typeof vi.fn>;
      loadAddon: ReturnType<typeof vi.fn>;
      cols: number;
      rows: number;
    }>,
);

vi.mock("@xterm/xterm", () => ({
  Terminal: class TerminalMock {
    open = vi.fn();
    write = vi.fn();
    writeln = vi.fn();
    dispose = vi.fn();
    clear = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    loadAddon = vi.fn();
    cols = 80;
    rows = 24;
    constructor() {
      terminalInstances.push(this);
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FitAddonMock {
    fit = vi.fn();
  },
}));

let useWorkspaceStore: typeof import("../../store/useWorkspaceStore")["useWorkspaceStore"];
let TerminalPanel: typeof import("./TerminalPanel")["TerminalPanel"];

beforeEach(async () => {
  vi.clearAllMocks();
  terminalInstances.length = 0;
  apiMock.saveLayout.mockResolvedValue(undefined);
  apiMock.deleteTerminal.mockResolvedValue(undefined);
  apiMock.sendEvent.mockReturnValue(true);
  apiMock.readTerminalOutput.mockResolvedValue({
    protocolVersion: 1,
    terminalId: "session-1",
    chunks: [],
    latestSequence: 0,
    truncated: false,
  });
  ({ useWorkspaceStore } = await import("../../store/useWorkspaceStore"));
  ({ TerminalPanel } = await import("./TerminalPanel"));
});

function terminalNode(id: string, cwd: string): TerminalFlowNode {
  return {
    id,
    type: "terminalPanel",
    position: { x: 0, y: 0 },
    data: { panelType: "terminal", dock: "floating", title: `Terminal — ${cwd}`, cwd },
  };
}

function renderTerminalPanel(
  id: string,
  cwd: string,
  wrapper: "strict" | "plain" = "plain",
) {
  const data = terminalNode(id, cwd).data;
  const tree = (
    <ReactFlowProvider>
      <TerminalPanel id={id} data={data} height={310} />
    </ReactFlowProvider>
  );
  return render(wrapper === "strict" ? <StrictMode>{tree}</StrictMode> : tree);
}

describe("TerminalPanel", () => {
  it("creates exactly one server-side session under React Strict Mode's double-invoke, and never discards it", async () => {
    const panelId = "panel-terminal-regression";
    apiMock.createTerminal.mockResolvedValue({
      protocolVersion: 1,
      id: "session-1",
      cwd: ".",
      shell: "/bin/zsh",
      createdAt: new Date(0).toISOString(),
      status: "running",
    });
    useWorkspaceStore.setState({
      demoMode: false,
      connection: "connected",
      compactMode: false,
      nodes: [terminalNode(panelId, ".")],
      terminalRuntimes: {},
    });

    await act(async () => {
      renderTerminalPanel(panelId, ".", "strict");
    });

    await waitFor(() => {
      expect(apiMock.createTerminal).toHaveBeenCalledTimes(1);
    });
    expect(apiMock.createTerminal).toHaveBeenCalledWith(".", panelId);
    expect(apiMock.deleteTerminal).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(useWorkspaceStore.getState().terminalRuntimes[panelId]).toEqual({
        terminalId: "session-1",
        cwd: ".",
        status: "running",
      });
    });
  });

  it("mounts the demo transcript without requesting a server session in demo mode", async () => {
    const panelId = "panel-terminal-demo";
    useWorkspaceStore.setState({
      demoMode: true,
      connection: "degraded",
      compactMode: false,
      nodes: [terminalNode(panelId, "~/constelix")],
      terminalRuntimes: {},
    });

    await act(async () => {
      renderTerminalPanel(panelId, "~/constelix");
    });

    await waitFor(() => {
      expect(terminalInstances.length).toBeGreaterThan(0);
    });
    const terminal = terminalInstances[0]!;
    expect(terminal.open).toHaveBeenCalledTimes(1);
    expect(terminal.writeln).toHaveBeenCalled();
    expect(apiMock.createTerminal).not.toHaveBeenCalled();
    expect(apiMock.readTerminalOutput).not.toHaveBeenCalled();
  });
});
