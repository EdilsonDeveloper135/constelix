import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.platform !== "darwin") {
  process.stdout.write("Packaged CLI smoke skipped: Constelix MVP targets macOS.\n");
  process.exit(0);
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "constelix-package-smoke-"));
const workspaceRoot = join(temporaryRoot, "workspace with spaces");
const packageDirectory = join(temporaryRoot, "package");
const installRoot = join(temporaryRoot, "install");
let child: ChildProcessWithoutNullStreams | undefined;

try {
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(packageDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(workspaceRoot, "main.ts"),
    "export const packagedCliSmoke = true;\n",
    "utf8",
  );

  await execFileAsync("pnpm", ["build"], {
    cwd: repositoryRoot,
    timeout: 300_000,
  });
  await execFileAsync(
    "pnpm",
    [
      "--filter",
      "@constelix/agent",
      "pack",
      "--pack-destination",
      packageDirectory,
    ],
    { cwd: repositoryRoot, timeout: 120_000 },
  );
  const archiveName = (await readdir(packageDirectory)).find((name) =>
    name.endsWith(".tgz"),
  );
  if (!archiveName) throw new Error("pnpm pack did not produce a tarball.");
  const archivePath = join(packageDirectory, archiveName);

  await execFileAsync(
    "npm",
    [
      "install",
      "--prefix",
      installRoot,
      "--ignore-scripts=false",
      "--no-audit",
      "--no-fund",
      archivePath,
    ],
    { cwd: temporaryRoot, timeout: 300_000 },
  );

  const executable = join(
    installRoot,
    "node_modules",
    ".bin",
    "constelix",
  );
  const environment = { ...process.env };
  delete environment.OPENAI_API_KEY;
  delete environment.CONSTELIX_CAPABILITY_TOKEN;
  child = spawn(
    executable,
    [workspaceRoot, "--no-open", "--port", "0"],
    {
      cwd: workspaceRoot,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const launch = await waitForLaunch(child, 30_000);
  const response = await waitForDashboard(launch.origin, 30_000);
  if (!response.includes("<title>Constelix</title>")) {
    throw new Error("The packaged CLI did not serve the Constelix dashboard.");
  }
  if (launch.stdout.includes("#token=")) {
    throw new Error("The packaged CLI printed its capability token.");
  }

  child.kill("SIGTERM");
  await waitForExit(child, 10_000);
  child = undefined;
  process.stdout.write(
    `${JSON.stringify(
      {
        archive: archiveName,
        workspaceWithSpaces: true,
        dashboardServed: true,
        capabilityPrinted: false,
        passed: true,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (
    child &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    child.kill("SIGKILL");
    await waitForExit(child, 5_000).catch(() => undefined);
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

function waitForLaunch(
  processHandle: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ origin: string; stdout: string }> {
  return new Promise((resolveLaunch, rejectLaunch) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      rejectLaunch(new Error(`Packaged CLI startup timed out.\n${stderr}`));
    }, timeoutMs);
    timeout.unref();
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const origin = /Local agent: (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1];
      if (!origin) return;
      cleanup();
      resolveLaunch({ origin, stdout });
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code: number | null) => {
      cleanup();
      rejectLaunch(
        new Error(`Packaged CLI exited before startup (${code ?? "unknown"}).\n${stderr}`),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      processHandle.stdout.off("data", onStdout);
      processHandle.stderr.off("data", onStderr);
      processHandle.off("exit", onExit);
    };
    processHandle.stdout.on("data", onStdout);
    processHandle.stderr.on("data", onStderr);
    processHandle.once("exit", onExit);
  });
}

async function waitForDashboard(origin: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin);
      if (response.ok) return response.text();
      lastError = new Error(`Dashboard responded with HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(
    `Packaged dashboard did not become available: ${
      lastError instanceof Error ? lastError.message : "unknown error"
    }`,
  );
}

function waitForExit(
  processHandle: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (
    processHandle.exitCode !== null ||
    processHandle.signalCode !== null
  ) {
    return Promise.resolve();
  }
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectExit(new Error("Packaged CLI did not stop after SIGTERM."));
    }, timeoutMs);
    timeout.unref();
    const onExit = () => {
      cleanup();
      resolveExit();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      processHandle.off("exit", onExit);
    };
    processHandle.once("exit", onExit);
  });
}
