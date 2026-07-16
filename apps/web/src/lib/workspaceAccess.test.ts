import { describe, expect, it } from "vitest";

import { canUseWorkspaceFeatures } from "./workspaceAccess";

describe("canUseWorkspaceFeatures", () => {
  it("keeps remote Ask and Act disabled until bootstrap hydration completes", () => {
    expect(
      canUseWorkspaceFeatures({
        demoMode: false,
        remoteHydrated: false,
        connection: "connected",
      }),
    ).toBe(false);
    expect(
      canUseWorkspaceFeatures({
        demoMode: false,
        remoteHydrated: true,
        connection: "connecting",
      }),
    ).toBe(false);
    expect(
      canUseWorkspaceFeatures({
        demoMode: false,
        remoteHydrated: true,
        connection: "connected",
      }),
    ).toBe(true);
  });

  it("keeps the standalone demo interactive without a local agent", () => {
    expect(
      canUseWorkspaceFeatures({
        demoMode: true,
        remoteHydrated: false,
        connection: "connecting",
      }),
    ).toBe(true);
  });
});
