import { describe, expect, it, vi } from "vitest";

import { chooseNativeWorkspaceFolder } from "./native-folder-picker";

describe("native workspace folder picker", () => {
  it("normalizes the selected macOS folder", async () => {
    const runner = vi.fn(async () => ({
      stdout: "/Users/developer/Projects/example/\n",
      stderr: "",
    }));

    await expect(
      chooseNativeWorkspaceFolder("darwin", runner),
    ).resolves.toEqual({
      protocolVersion: 1,
      status: "selected",
      path: "/Users/developer/Projects/example",
    });
  });

  it("treats user cancellation as a neutral result", async () => {
    const runner = vi.fn(async () => {
      throw Object.assign(new Error("execution error -128"), {
        stderr: "User canceled.",
      });
    });

    await expect(
      chooseNativeWorkspaceFolder("darwin", runner),
    ).resolves.toEqual({ protocolVersion: 1, status: "cancelled" });
  });

  it("reports unsupported platforms without launching a process", async () => {
    const runner = vi.fn();
    const result = await chooseNativeWorkspaceFolder("linux", runner);
    expect(result.status).toBe("unavailable");
    expect(runner).not.toHaveBeenCalled();
  });
});
