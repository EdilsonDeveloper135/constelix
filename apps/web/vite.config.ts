import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const webPort = parsePort(process.env.CONSTELIX_E2E_WEB_PORT, 5173);
const agentPort = parsePort(process.env.CONSTELIX_E2E_AGENT_PORT, 4321);

export default defineConfig({
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
    sourcemap: false
  }
});

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535
    ? port
    : fallback;
}
