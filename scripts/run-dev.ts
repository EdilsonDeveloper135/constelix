import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface DevCommand {
  label: "agent" | "web";
  args: string[];
}

export function buildDevCommands(workspacePath?: string): DevCommand[] {
  return [
    {
      label: "web",
      args: ["--filter", "@constelix/web", "dev"],
    },
    {
      label: "agent",
      args: [
        "--filter",
        "@constelix/agent",
        "dev",
        ...(workspacePath ? ["--", workspacePath] : []),
      ],
    },
  ];
}

export async function runDev(workspacePath?: string): Promise<void> {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) {
    throw new Error("Run this command through pnpm so the workspace CLI can be located.");
  }

  const children = buildDevCommands(workspacePath).map(({ args }) =>
    spawn(process.execPath, [pnpmCli, ...args], {
      env: process.env,
      stdio: "inherit",
    }),
  );

  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    children.forEach((child) => stopChild(child, signal));
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  let firstExit = 1;
  try {
    firstExit = await Promise.race(
      children.map(
        (child) =>
          new Promise<number>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code, signal) => {
              resolve(code ?? (signal === "SIGINT" ? 130 : 1));
            });
          }),
      ),
    );
  } finally {
    stop("SIGTERM");
    await Promise.all(children.map(waitForExit));
  }
  if (firstExit !== 0 && firstExit !== 130) process.exitCode = firstExit;
}

function stopChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = () => {
      child.off("exit", finish);
      child.off("close", finish);
      resolve();
    };
    child.once("exit", finish);
    child.once("close", finish);
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

if (isMainModule()) {
  void runDev(process.argv[2]).catch((error: unknown) => {
    process.stderr.write(
      `Constelix development startup failed: ${
        error instanceof Error ? error.message : "Unknown error"
      }\n`,
    );
    process.exitCode = 1;
  });
}
