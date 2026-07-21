import { describe, expect, it } from "vitest";

import type { WorkspaceNode } from "../types";
import {
  isDockedToolPanel,
  isFloatingCanvasNode,
  panelDock,
} from "./panelDock";

describe("tool panel docking", () => {
  it("keeps legacy panels floating when dock is absent", () => {
    const panel = editorPanel(undefined);

    expect(panelDock(panel)).toBe("floating");
    expect(isFloatingCanvasNode(panel)).toBe(true);
  });

  it("separates docked panels from the transformable canvas", () => {
    const panel = editorPanel("right");

    expect(isFloatingCanvasNode(panel)).toBe(false);
    expect(isDockedToolPanel(panel, "right")).toBe(true);
    expect(isDockedToolPanel(panel, "bottom")).toBe(false);
  });

  it("does not mount hidden panels in a dock", () => {
    expect(isDockedToolPanel({ ...editorPanel("right"), hidden: true })).toBe(
      false,
    );
  });
});

function editorPanel(dock: "floating" | "right" | "bottom" | undefined): WorkspaceNode {
  return {
    id: "panel-editor",
    type: "editorPanel",
    position: { x: 0, y: 0 },
    data: {
      panelType: "editor",
      ...(dock ? { dock } : {}),
      title: "Editor",
      relativePath: "src/index.ts",
      language: "typescript",
      preview: "",
    },
  } as WorkspaceNode;
}
