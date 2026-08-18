import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  hasToken: true,
  subscribe: vi.fn(),
  subscribeConnection: vi.fn(),
  subscribeWorkspaceReconciliation: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("../lib/api", () => ({ apiClient: apiMock }));

vi.mock("../lib/layout", () => ({
  layoutSemanticNodes: vi.fn().mockResolvedValue({}),
  resolveSemanticLayoutCollisions: vi.fn(
    (_nodes: unknown, proposed: Record<string, { x: number; y: number }>) =>
      proposed,
  ),
}));

let useWorkspaceStore: typeof import("../store/useWorkspaceStore")["useWorkspaceStore"];
let useAgentBridge: typeof import("./useAgentBridge")["useAgentBridge"];

beforeEach(async () => {
  vi.clearAllMocks();
  ({ useWorkspaceStore } = await import("../store/useWorkspaceStore"));
  ({ useAgentBridge } = await import("./useAgentBridge"));
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
});

describe("useAgentBridge", () => {
  it("marks the connection degraded without subscribing when there is no token and demo mode is off", () => {
    apiMock.hasToken = false;
    useWorkspaceStore.setState({ demoMode: false });

    renderHook(() => useAgentBridge());

    expect(useWorkspaceStore.getState().connection).toBe("degraded");
    expect(apiMock.subscribe).not.toHaveBeenCalled();
    expect(apiMock.connect).not.toHaveBeenCalled();
  });

  it("marks the connection connected without subscribing when there is no token but demo mode is on", () => {
    apiMock.hasToken = false;
    useWorkspaceStore.setState({ demoMode: true });

    renderHook(() => useAgentBridge());

    expect(useWorkspaceStore.getState().connection).toBe("connected");
    expect(apiMock.subscribe).not.toHaveBeenCalled();
  });

  it("subscribes to agent events and connects when a token is present, then tears everything down on unmount", () => {
    apiMock.hasToken = true;
    const unsubscribe = vi.fn();
    const unsubscribeConnection = vi.fn();
    const unsubscribeReconciliation = vi.fn();
    const disconnect = vi.fn();
    apiMock.subscribe.mockReturnValue(unsubscribe);
    apiMock.subscribeConnection.mockReturnValue(unsubscribeConnection);
    apiMock.subscribeWorkspaceReconciliation.mockReturnValue(
      unsubscribeReconciliation,
    );
    apiMock.connect.mockReturnValue(disconnect);

    const { unmount } = renderHook(() => useAgentBridge());

    expect(apiMock.subscribe).toHaveBeenCalledTimes(1);
    expect(apiMock.subscribeConnection).toHaveBeenCalledTimes(1);
    expect(apiMock.subscribeWorkspaceReconciliation).toHaveBeenCalledTimes(1);
    expect(apiMock.connect).toHaveBeenCalledTimes(1);

    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribeConnection).toHaveBeenCalledTimes(1);
    expect(unsubscribeReconciliation).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("reports 'connecting' once the transport is up but the workspace has not hydrated yet", () => {
    apiMock.hasToken = true;
    useWorkspaceStore.setState({ remoteHydrated: false });
    let connectionListener: ((state: string) => void) | undefined;
    apiMock.subscribeConnection.mockImplementation((listener: (state: string) => void) => {
      connectionListener = listener;
      return vi.fn();
    });

    renderHook(() => useAgentBridge());
    connectionListener?.("connected");

    expect(useWorkspaceStore.getState().connection).toBe("connecting");
  });

  it("reports 'connected' once the transport is up and the workspace has hydrated", () => {
    apiMock.hasToken = true;
    useWorkspaceStore.setState({ remoteHydrated: true });
    let connectionListener: ((state: string) => void) | undefined;
    apiMock.subscribeConnection.mockImplementation((listener: (state: string) => void) => {
      connectionListener = listener;
      return vi.fn();
    });

    renderHook(() => useAgentBridge());
    connectionListener?.("connected");

    expect(useWorkspaceStore.getState().connection).toBe("connected");
  });
});
