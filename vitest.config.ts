import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "coverage",
      include: [
        "apps/*/src/**/*.{ts,tsx}",
        "packages/*/src/**/*.ts",
        "scripts/benchmark-utils.ts",
      ],
      exclude: [
        "**/*.test.ts",
        "**/*.d.ts",
        "apps/web/src/main.tsx",
        "scripts/smoke-*.ts",
      ],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 54,
        lines: 64,
      },
    }
  }
});
