import { multiply } from "../../../packages/shared/src/math.js";

export function renderMetric(value: number): string {
  return `metric:${multiply(value, 2)}`;
}
