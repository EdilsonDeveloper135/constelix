import { defineConfig, devices } from "@playwright/test";

const webServerUrl = "http://127.0.0.1:5173";
const reuseExistingWebServer =
  !process.env.CI && process.env.CONSTELIX_E2E_REUSE_WEB_SERVER === "1";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  use: {
    baseURL: webServerUrl,
    trace: "retain-on-failure"
  },
  webServer: {
    command: "pnpm --dir apps/web exec vite --host 127.0.0.1 --port 5173 --strictPort",
    url: webServerUrl,
    reuseExistingServer: reuseExistingWebServer,
    gracefulShutdown: {
      signal: "SIGTERM",
      timeout: 5_000
    },
    timeout: 120_000
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 960 } }
    }
  ]
});
