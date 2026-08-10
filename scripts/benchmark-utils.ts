import { availableParallelism, loadavg } from "node:os";

export interface BenchmarkEnvironment {
  availableParallelism: number;
  loadAverage: readonly [number, number, number];
}

export function benchmarkEnvironment(): BenchmarkEnvironment {
  const average = loadavg();
  return {
    availableParallelism: availableParallelism(),
    loadAverage: [
      roundHundredths(average[0]),
      roundHundredths(average[1]),
      roundHundredths(average[2]),
    ],
  };
}

export function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) {
    throw new Error("A percentile requires at least one sample.");
  }
  if (!Number.isFinite(quantile) || quantile <= 0 || quantile > 1) {
    throw new Error("A percentile quantile must be greater than 0 and at most 1.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(sorted.length * quantile) - 1;
  return sorted[index]!;
}

function roundHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}
