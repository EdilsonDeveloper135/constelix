import { describe, expect, it } from "vitest";
import { AnalyzerWorkerClient } from "./analyzer-worker-client.js";

describe("AnalyzerWorkerClient lifecycle", () => {
  it("terminates after a completed analysis", async () => {
    const analyzer = new AnalyzerWorkerClient();

    await expect(
      analyzer.analyze(
        [
          {
            relativePath: "main.ts",
            source: "export const answer = 42;\n",
            language: "typescript",
          },
        ],
        { workspaceId: "worker-close-test" },
      ),
    ).resolves.toMatchObject({
      snapshot: { workspaceId: "worker-close-test" },
    });

    await expect(analyzer.close()).resolves.toBeUndefined();
  });

  it("rejects active analysis when closing", async () => {
    const analyzer = new AnalyzerWorkerClient();
    const analysis = analyzer.analyze(
      Array.from({ length: 100 }, (_, index) => ({
        relativePath: `source-${index}.ts`,
        source: `export function value${index}() { return ${index}; }\n`,
        language: "typescript" as const,
      })),
      { workspaceId: "worker-pending-close-test" },
    );
    const outcome = analysis.then(
      () => new Error("The active analysis unexpectedly completed."),
      (error: unknown) => error,
    );

    await expect(analyzer.close()).resolves.toBeUndefined();
    expect(await outcome).toMatchObject({
      message: expect.stringContaining("analyzer worker was closed"),
    });
  });
});
