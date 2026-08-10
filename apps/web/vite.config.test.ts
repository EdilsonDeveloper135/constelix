import { describe, expect, it } from "vitest";
import { isExpectedE2eProxyDisconnect } from "./vite.config.js";

describe("Vite E2E proxy logging", () => {
  it("suppresses only expected browser disconnect noise", () => {
    expect(isExpectedE2eProxyDisconnect("ws proxy error:\nError: read ECONNRESET")).toBe(true);
    expect(isExpectedE2eProxyDisconnect("ws proxy socket error:\nError: write EPIPE")).toBe(true);
    expect(isExpectedE2eProxyDisconnect("http proxy error: /api\nError: write EPIPE")).toBe(true);
    expect(isExpectedE2eProxyDisconnect("http proxy socket error: /api\nError: read ECONNRESET")).toBe(true);
    expect(isExpectedE2eProxyDisconnect("ws proxy error:\nError: connect ECONNREFUSED")).toBe(false);
    expect(isExpectedE2eProxyDisconnect("application failure: ECONNRESET")).toBe(false);
  });
});
