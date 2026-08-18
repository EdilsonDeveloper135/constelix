import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// RTL's own auto-cleanup only registers itself when it detects the test
// framework's `afterEach` as a true global; this project deliberately runs
// without `test.globals` (every file imports vitest's API explicitly), so
// unmounting after each test has to be wired up here instead.
afterEach(cleanup);

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, "ResizeObserver", {
  writable: true,
  configurable: true,
  value: ResizeObserverMock,
});

Object.defineProperty(window, "matchMedia", {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// Node 24's own experimental global `localStorage` (unconfigured here, no
// --localstorage-file) shadows jsdom's working implementation and throws on
// access, so jsdom's window ends up with a non-functional stub. Replace it
// with a plain in-memory Storage so code that reads/writes localStorage
// (useShellStore's persisted theme/text-scale) works under test.
class MemoryStorageMock implements Storage {
  #data = new Map<string, string>();
  get length(): number {
    return this.#data.size;
  }
  clear(): void {
    this.#data.clear();
  }
  getItem(key: string): string | null {
    return this.#data.has(key) ? this.#data.get(key)! : null;
  }
  key(index: number): string | null {
    return [...this.#data.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.#data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.#data.set(key, String(value));
  }
}
Object.defineProperty(window, "localStorage", {
  writable: true,
  configurable: true,
  value: new MemoryStorageMock(),
});
Object.defineProperty(window, "sessionStorage", {
  writable: true,
  configurable: true,
  value: new MemoryStorageMock(),
});
