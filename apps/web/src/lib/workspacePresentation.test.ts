import { describe, expect, it } from "vitest";

import {
  askModeLabel,
  connectionLabel,
  summarizeWorkspacePath,
  workspaceModeLabel,
} from "./workspacePresentation";

describe("workspace presentation", () => {
  it("labels connection, access, and Ask modes explicitly", () => {
    expect(connectionLabel("connected", false)).toBe(
      "Agente local conectado",
    );
    expect(connectionLabel("degraded", false)).toBe(
      "Agente local desconectado",
    );
    expect(connectionLabel("connected", true)).toBe("Modo demostración");
    expect(workspaceModeLabel("read")).toBe("Lectura");
    expect(workspaceModeLabel("edit")).toBe("Edición");
    expect(askModeLabel("local")).toBe("Ask Local");
    expect(askModeLabel("openai")).toBe("Ask LLM");
  });

  it("keeps only a short non-sensitive path suffix", () => {
    expect(
      summarizeWorkspacePath(
        "/Users/developer/Projects/client/private-workspace",
      ),
    ).toBe("…/Projects/client/private-workspace");
    expect(summarizeWorkspacePath("…/private-workspace")).toBe(
      "…/private-workspace",
    );
  });
});
