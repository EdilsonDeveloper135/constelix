import react from "@vitejs/plugin-react";
import { createLogger, defineConfig } from "vite";

const webPort = parsePort(process.env.CONSTELIX_E2E_WEB_PORT, 5173);
const agentPort = parsePort(process.env.CONSTELIX_E2E_AGENT_PORT, 4321);
const logger = createLogger();

if (process.env.CONSTELIX_E2E_WEB_PORT !== undefined) {
  const reportError = logger.error.bind(logger);
  logger.error = (message, options) => {
    if (isExpectedE2eProxyDisconnect(message)) return;
    reportError(message, options);
  };
}

export default defineConfig({
  customLogger: logger,
  plugins: [react()],
  server: {
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${agentPort}`,
        changeOrigin: true,
        ws: true
      }
    }
  },
  build: {
    target: "es2022",
    sourcemap: false,
    rolldownOptions: {
      output: {
        codeSplitting: {
          minSize: 20_000,
          groups: [
            {
              name: "monaco",
              test: /node_modules[\\/]monaco-editor[\\/]/u,
              priority: 40,
              maxSize: 1_500_000,
            },
            {
              name: "react-vendor",
              test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/u,
              priority: 30,
            },
            {
              name: "canvas-vendor",
              test: /node_modules[\\/]@xyflow[\\/]/u,
              priority: 20,
            },
            {
              name: "state-vendor",
              test: /node_modules[\\/](?:@tanstack|zustand)[\\/]/u,
              priority: 10,
            },
          ],
        },
      },
    },
  }
});

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535
    ? port
    : fallback;
}

export function isExpectedE2eProxyDisconnect(message: string): boolean {
  return /(?:http|ws) proxy(?: socket)? error:/u.test(message) && /\b(?:ECONNRESET|EPIPE)\b/u.test(message);
}
