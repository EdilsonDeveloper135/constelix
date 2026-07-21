import { describe, expect, it } from "vitest";

import {
  semanticNodeCapabilities,
  semanticNodeCwd,
} from "./semanticNodeActions";
import type { SemanticNodeData } from "../types";

describe("semantic node actions", () => {
  it("offers exploration and terminals only for hierarchy nodes", () => {
    const directory = node({ kind: "directory", relativePath: "src" });
    expect(semanticNodeCapabilities(directory)).toEqual({
      canInspect: true,
      canActivate: true,
      canOpenFile: false,
      canOpenTerminal: true,
    });

    const file = node({ kind: "file", relativePath: "src/index.ts" });
    expect(semanticNodeCapabilities(file)).toEqual({
      canInspect: true,
      canActivate: false,
      canOpenFile: true,
      canOpenTerminal: false,
    });
  });

  it("opens module terminals in the module directory", () => {
    expect(
      semanticNodeCwd(node({ kind: "module", relativePath: "src/index.ts" })),
    ).toBe("src");
    expect(semanticNodeCwd(node({ kind: "workspace" }))).toBe(".");
  });
});

function node(
  patch: Partial<SemanticNodeData> & Pick<SemanticNodeData, "kind">,
): SemanticNodeData {
  return { label: "Node", ...patch };
}
