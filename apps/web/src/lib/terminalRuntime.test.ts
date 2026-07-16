import { describe, expect, it } from "vitest";

import {
  markTerminalRuntimeExited,
  shouldMountTerminal,
  terminalCanAcceptInput,
} from "./terminalRuntime";

describe("terminal runtime lifecycle", () => {
  it("marks only the exited PTY and requires an explicit replacement", () => {
    const runtimes = {
      first: {
        terminalId: "pty-one",
        cwd: ".",
        status: "running" as const,
      },
      second: {
        terminalId: "pty-two",
        cwd: "apps/web",
        status: "running" as const,
      },
    };
    const exited = markTerminalRuntimeExited(
      runtimes,
      "pty-two",
      "proceso terminado: 0",
    );

    expect(exited.first?.status).toBe("running");
    expect(exited.second).toMatchObject({
      terminalId: "pty-two",
      status: "exited",
      exitLabel: "proceso terminado: 0",
    });
    expect(terminalCanAcceptInput(exited.second)).toBe(false);
  });

  it("safely remounts a connected PTY after culling or reconnect", () => {
    expect(shouldMountTerminal(false, "degraded", false)).toBe(false);
    expect(shouldMountTerminal(false, "connected", false)).toBe(true);
    expect(shouldMountTerminal(false, "connected", true)).toBe(false);
    expect(shouldMountTerminal(true, "degraded", false)).toBe(true);
  });
});
