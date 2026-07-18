import { defineConfig, devices } from "@playwright/test";

const webPort = parsePort(process.env.CONSTELIX_E2E_WEB_PORT, 5273);
const agentPort = parsePort(process.env.CONSTELIX_E2E_AGENT_PORT, 4421);
const webServerUrl = `http://127.0.0.1:${webPort}`;
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
    command: `pnpm --dir apps/web exec vite --host 127.0.0.1 --port ${webPort} --strictPort`,
    url: webServerUrl,
    env: {
      ...process.env,
      CONSTELIX_E2E_WEB_PORT: String(webPort),
      CONSTELIX_E2E_AGENT_PORT: String(agentPort)
    },
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

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535
    ? port
    : fallback;
}
