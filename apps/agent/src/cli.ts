#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnvironment } from "dotenv";
import { canonicalizeWorkspace, redactSecrets } from "./security.js";
import { startAgentServer } from "./server.js";

interface CliOptions {
  path?: string;
  dev: boolean;
  openBrowser: boolean;
  port?: number;
}

export async function run(argv = process.argv.slice(2)): Promise<void> {
  assertSupportedNode();
  const cli = parseArgs(argv);
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(moduleDirectory, "../../..");
  const requestedPath = cli.path ?? (cli.dev ? projectRoot : process.cwd());
  const workspaceRoot = await canonicalizeWorkspace(requestedPath);
  if (cli.dev) {
    loadEnvironment({ path: resolve(projectRoot, ".env.local"), quiet: true, override: false });
  }
  const server = await startAgentServer({
    workspaceRoot,
    dev: cli.dev,
    ...(cli.port === undefined ? {} : { port: cli.port }),
  });

  const browserOrigin = cli.dev
    ? process.env.CONSTELIX_WEB_ORIGIN ?? "http://127.0.0.1:5173"
    : server.origin;
  const launchUrl = `${browserOrigin}/#token=${encodeURIComponent(server.capabilityToken)}&agent=${encodeURIComponent(server.origin)}`;
  process.stdout.write(`Constelix is running for ${workspaceRoot}\n`);
  process.stdout.write(`Local agent: ${server.origin}\n`);
  if (cli.openBrowser) openBrowser(launchUrl);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.close();
  };
  process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const result: CliOptions = { dev: false, openBrowser: true };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;
    if (value === "--") continue;
    if (value === "--dev") result.dev = true;
    else if (value === "--no-open") result.openBrowser = false;
    else if (value === "--port") {
      const port = Number.parseInt(argv[index + 1] ?? "", 10);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new Error("--port must be an integer between 0 and 65535.");
      }
      result.port = port;
      index += 1;
    } else if (value.startsWith("-")) {
      throw new Error(`Unknown option: ${value}`);
    } else if (result.path === undefined) result.path = value;
    else throw new Error("Constelix accepts a single workspace path.");
  }
  return result;
}

function assertSupportedNode(): void {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major < 24 && process.env.CONSTELIX_ALLOW_UNSUPPORTED_NODE !== "1") {
    throw new Error("Constelix requires Node.js 24 or newer.");
  }
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

if (isMainModule()) {
  run().catch((error) => {
    process.stderr.write(
      `Constelix failed: ${redactSecrets(error instanceof Error ? error.message : "Unknown error")}\n`,
    );
    process.exitCode = 1;
  });
}

function isMainModule(): boolean {
  const executable = process.argv[1];
  if (!executable) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(executable);
  } catch {
    return false;
  }
}
