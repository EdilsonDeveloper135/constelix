import { beforeEach, describe, expect, it } from "vitest";

import { useShellStore } from "./useShellStore";

describe("shell state", () => {
  beforeEach(() => {
    useShellStore.setState({
      onboardingOpen: true,
      commandPaletteOpen: false,
      settingsOpen: false,
      helpOpen: false,
      themeMode: "dark",
      textScale: "default",
    });
  });

  it("keeps transient product surfaces outside workspace state", () => {
    const state = useShellStore.getState();
    state.setSettingsOpen(true);
    state.setHelpOpen(true);
    state.setCommandPaletteOpen(true);

    expect(useShellStore.getState()).toMatchObject({
      settingsOpen: true,
      helpOpen: true,
      commandPaletteOpen: true,
    });
  });
});
