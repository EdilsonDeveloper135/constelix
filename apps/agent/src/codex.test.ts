import { describe, expect, it } from "vitest";

import { createCodexSandboxPolicy } from "./codex.js";

describe("createCodexSandboxPolicy", () => {
  it("keeps writes inside the workspace and excludes global temporary directories", () => {
    expect(createCodexSandboxPolicy("/workspace")).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/workspace"],
      networkAccess: true,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    });
  });
});
