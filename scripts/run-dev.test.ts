import { describe, expect, it } from "vitest";

import { buildDevCommands, parseDevWorkspacePath } from "./run-dev";

describe("development command orchestration", () => {
  it.each([
    [["/tmp/project"], "/tmp/project"],
    [["--", "/tmp/project"], "/tmp/project"],
    [[], undefined],
    [["--"], undefined],
  ] as const)("parses pnpm workspace arguments %#", (argv, expected) => {
    expect(parseDevWorkspacePath([...argv])).toBe(expected);
  });

  it("rejects ambiguous workspace arguments", () => {
    expect(() => parseDevWorkspacePath(["/tmp/one", "/tmp/two"])).toThrow(
      "Expected at most one workspace path",
    );
  });

  it("forwards the workspace path only to the local agent", () => {
    const commands = buildDevCommands("/tmp/project with spaces");

    expect(commands.find((command) => command.label === "web")?.args).toEqual([
      "--filter",
      "@constelix/web",
      "dev",
    ]);
    expect(commands.find((command) => command.label === "agent")?.args).toEqual([
      "--filter",
      "@constelix/agent",
      "dev",
      "--",
      "/tmp/project with spaces",
    ]);
  });
});
