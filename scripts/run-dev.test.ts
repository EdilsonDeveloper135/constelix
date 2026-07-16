import { describe, expect, it } from "vitest";

import { buildDevCommands } from "./run-dev";

describe("development command orchestration", () => {
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
