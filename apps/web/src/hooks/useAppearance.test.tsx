import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppearance, useResolvedTheme } from "./useAppearance";
import { useShellStore } from "../store/useShellStore";

function mockMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<() => void>();
  const mediaQueryList = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: light)",
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_event: string, listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_event: string, listener: () => void) => {
      listeners.delete(listener);
    },
    dispatchEvent: () => false,
  };
  window.matchMedia = vi.fn().mockReturnValue(mediaQueryList);
  return {
    setMatches(next: boolean) {
      matches = next;
      listeners.forEach((listener) => listener());
    },
  };
}

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

beforeEach(() => {
  useShellStore.setState({ themeMode: "dark", textScale: "default" });
});

describe("useResolvedTheme", () => {
  it("returns the explicit theme mode when it is not 'system'", () => {
    mockMatchMedia(false);
    useShellStore.setState({ themeMode: "light" });
    const { result } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe("light");
  });

  it("resolves 'system' from the OS light/dark media query", () => {
    mockMatchMedia(true);
    useShellStore.setState({ themeMode: "system" });
    const { result } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe("light");
  });

  it("tracks OS theme changes while in 'system' mode", () => {
    const media = mockMatchMedia(false);
    useShellStore.setState({ themeMode: "system" });
    const { result } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe("dark");

    act(() => media.setMatches(true));
    expect(result.current).toBe("light");
  });
});

describe("useAppearance", () => {
  it("stamps the resolved theme and text scale onto the document element", () => {
    mockMatchMedia(false);
    useShellStore.setState({ themeMode: "dark", textScale: "large" });
    renderHook(() => useAppearance());

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.textScale).toBe("large");
  });

  it("resolves 'system' theme mode against the OS preference", () => {
    mockMatchMedia(true);
    useShellStore.setState({ themeMode: "system", textScale: "default" });
    renderHook(() => useAppearance());

    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
