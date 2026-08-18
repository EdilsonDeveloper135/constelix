import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: [
            "packages/**/*.test.ts",
            "apps/**/*.test.ts",
            "scripts/**/*.test.ts",
          ],
        },
      },
      {
        test: {
          name: "web-components",
          environment: "jsdom",
          include: ["apps/web/src/**/*.test.tsx"],
          setupFiles: ["./apps/web/src/test-setup.ts"],
        },
      },
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
        "**/*.test.tsx",
        "**/*.d.ts",
        "apps/web/src/main.tsx",
        "apps/web/src/test-setup.ts",
        "scripts/smoke-*.ts",
      ],
      thresholds: {
        statements: 64,
        branches: 54,
        functions: 60,
        lines: 67,
      },
    }
  }
});
