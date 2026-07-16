import { describe, expect, it } from "vitest";

import { nextHorizontalTabIndex } from "./keyboardNavigation";

describe("horizontal tab keyboard navigation", () => {
  it("wraps with the left and right arrow keys", () => {
    expect(nextHorizontalTabIndex(0, "ArrowLeft", 2)).toBe(1);
    expect(nextHorizontalTabIndex(1, "ArrowRight", 2)).toBe(0);
  });

  it("moves to the first or last tab with Home and End", () => {
    expect(nextHorizontalTabIndex(1, "Home", 3)).toBe(0);
    expect(nextHorizontalTabIndex(0, "End", 3)).toBe(2);
  });

  it("ignores unrelated keys and empty tab lists", () => {
    expect(nextHorizontalTabIndex(0, "Enter", 2)).toBeNull();
    expect(nextHorizontalTabIndex(0, "ArrowRight", 0)).toBeNull();
  });
});
