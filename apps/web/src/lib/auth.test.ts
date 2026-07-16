import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readCapabilityToken,
  resetCapabilityTokenForTests,
} from "./auth";

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window",
);

afterEach(() => {
  resetCapabilityTokenForTests();
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("capability token bootstrap", () => {
  it("reads the fragment once and immediately removes it from browser history", () => {
    const replaceState = vi.fn();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          hash: "#token=constelix-test-capability",
          pathname: "/workspace",
          search: "?view=graph",
        },
        history: { replaceState },
      },
    });

    expect(readCapabilityToken()).toBe("constelix-test-capability");
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/workspace?view=graph",
    );

    window.location.hash = "#token=changed";
    expect(readCapabilityToken()).toBe("constelix-test-capability");
  });

  it("supports a raw fragment without persisting it", () => {
    const replaceState = vi.fn();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          hash: "#raw%20capability",
          pathname: "/",
          search: "",
        },
        history: { replaceState },
      },
    });

    expect(readCapabilityToken()).toBe("raw capability");
    expect(replaceState).toHaveBeenCalledOnce();
  });
});
