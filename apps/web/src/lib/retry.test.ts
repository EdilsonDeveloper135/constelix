import { describe, expect, it, vi } from "vitest";

import { isAbortError, retryWithDelays } from "./retry";

describe("bounded retry", () => {
  it("retries transient failures using the configured bounded schedule", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new TypeError("temporary network failure"))
      .mockRejectedValueOnce(new TypeError("temporary network failure"))
      .mockResolvedValue("ready");
    const waits: number[] = [];

    await expect(
      retryWithDelays(operation, {
        retryDelaysMs: [0, 100, 400],
        shouldRetry: (error) => error instanceof TypeError,
        wait: async (delayMs) => {
          waits.push(delayMs);
        },
      }),
    ).resolves.toBe("ready");

    expect(operation).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([100, 400]);
  });

  it("stops immediately when the caller aborts the retry sequence", async () => {
    const controller = new AbortController();
    const operation = vi.fn().mockRejectedValue(new TypeError("temporary"));

    await expect(
      retryWithDelays(operation, {
        signal: controller.signal,
        retryDelaysMs: [0, 100, 400],
        shouldRetry: () => true,
        wait: async () => {
          controller.abort();
          if (controller.signal.aborted) {
            throw new DOMException("aborted", "AbortError");
          }
        },
      }),
    ).rejects.toSatisfy(isAbortError);

    expect(operation).toHaveBeenCalledOnce();
  });
});
