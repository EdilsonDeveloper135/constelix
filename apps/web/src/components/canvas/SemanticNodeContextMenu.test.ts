import { describe, expect, it } from "vitest";

import { clampContextMenuPosition } from "./SemanticNodeContextMenu";

describe("semantic context menu positioning", () => {
  it("keeps the menu within the visible viewport", () => {
    expect(
      clampContextMenuPosition(
        { x: 980, y: 760 },
        { width: 1000, height: 800 },
        { width: 232, height: 200 },
      ),
    ).toEqual({ x: 760, y: 592 });
  });

  it("keeps a minimum viewport gutter", () => {
    expect(
      clampContextMenuPosition(
        { x: -20, y: -5 },
        { width: 1000, height: 800 },
        { width: 232, height: 200 },
      ),
    ).toEqual({ x: 8, y: 8 });
  });
});
