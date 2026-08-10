import { describe, expect, it } from "vitest";
import { benchmarkEnvironment, percentile } from "./benchmark-utils.js";

describe("benchmark utilities", () => {
  it("calculates nearest-rank percentiles without mutating samples", () => {
    const samples = [8, 1, 5, 3];
    expect(percentile(samples, 0.5)).toBe(3);
    expect(percentile(samples, 0.95)).toBe(8);
    expect(samples).toEqual([8, 1, 5, 3]);
  });

  it("rejects empty samples and invalid quantiles", () => {
    expect(() => percentile([], 0.95)).toThrow("at least one sample");
    expect(() => percentile([1], 0)).toThrow("greater than 0");
    expect(() => percentile([1], 1.1)).toThrow("at most 1");
  });

  it("reports bounded host-load diagnostics", () => {
    const environment = benchmarkEnvironment();
    expect(environment.availableParallelism).toBeGreaterThan(0);
    expect(environment.loadAverage).toHaveLength(3);
    expect(environment.loadAverage.every(Number.isFinite)).toBe(true);
  });
});
