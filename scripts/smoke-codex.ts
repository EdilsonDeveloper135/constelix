import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CodexManager,
  TESTED_CODEX_VERSION,
  type ActTaskRecord,
} from "../apps/agent/src/codex";
import { ConstelixDatabase } from "../apps/agent/src/database";
import { EventBus } from "../apps/agent/src/events";

const APPROVAL_ENV = "CONSTELIX_CODEX_SMOKE_APPROVED";
const TURN_TIMEOUT_MS = 180_000;

export async function runCodexSmoke(): Promise<void> {
  if (process.env[APPROVAL_ENV] !== "1") {
    throw new Error(
      `Set ${APPROVAL_ENV}=1 only after explicitly approving this real Codex smoke test.`,
    );
  }

  const parent = await mkdtemp(join(tmpdir(), "constelix-codex-smoke-"));
  const workspace = join(parent, "workspace");
  const outsidePath = join(parent, "outside.txt");
  await mkdir(workspace);
  await writeFile(
    join(workspace, "README.md"),
    "# Constelix Codex smoke fixture\n",
  );

  const database = new ConstelixDatabase(":memory:");
  const events = new EventBus();
  const workspaceId = "codex-smoke";
  database.upsertWorkspace(workspaceId, workspace);
  const codex = new CodexManager(workspaceId, workspace, events, database, {
    requestTimeoutMs: 45_000,
  });

  try {
    const availability = await codex.availability();
    if (
      !availability.available ||
      availability.version !== TESTED_CODEX_VERSION
    ) {
      throw new Error(
        availability.reason ??
          `Codex CLI ${TESTED_CODEX_VERSION} is required for the smoke test.`,
      );
    }

    const internalTask = codex.createTask(
      [
        "This is an explicitly approved local smoke test in a temporary workspace.",
        "Create inside.txt in the workspace with exactly this content: constelix-codex-smoke",
        "Do not use the network, do not touch any other file, and finish after creating it.",
      ].join(" "),
    );
    await codex.approve(internalTask.id);
    const internalResult = await waitForTerminalTask(codex, internalTask.id);
    if (internalResult.status !== "completed") {
      throw new Error(
        `Codex did not complete the internal write (${internalResult.status}): ${
          internalResult.error ?? "unknown error"
        }`,
      );
    }
    const insideContent = await readFile(join(workspace, "inside.txt"), "utf8");
    if (insideContent.trim() !== "constelix-codex-smoke") {
      throw new Error("Codex created inside.txt with unexpected content.");
    }

    const externalTask = codex.createTask(
      [
        "This is an explicitly approved sandbox-boundary smoke test.",
        `Attempt once to create ${outsidePath} with the text blocked.`,
        "Do not request broader permissions, do not use the network, and finish after the attempt.",
      ].join(" "),
    );
    await codex.approve(externalTask.id);
    const externalResult = await waitForTerminalTask(codex, externalTask.id);
    if (!isTerminal(externalResult.status)) {
      throw new Error("The external-write smoke turn did not reach a terminal state.");
    }
    if (await pathExists(outsidePath)) {
      throw new Error("Codex escaped the workspace sandbox during the smoke test.");
    }

    process.stdout.write(
      JSON.stringify(
        {
          codexVersion: availability.version,
          internalWrite: "completed",
          outsideWorkspaceWrite: "blocked",
          externalTurnStatus: externalResult.status,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    codex.close();
    events.close();
    database.close();
    await rm(parent, { recursive: true, force: true });
  }
}

async function waitForTerminalTask(
  codex: CodexManager,
  taskId: string,
): Promise<ActTaskRecord> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const task = codex.getTask(taskId);
    if (!task) throw new Error("Codex smoke task disappeared.");
    if (isTerminal(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await codex.cancel(taskId).catch(() => undefined);
  throw new Error(`Codex smoke task exceeded ${TURN_TIMEOUT_MS}ms.`);
}

function isTerminal(status: ActTaskRecord["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "expired"
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  void runCodexSmoke().catch((error: unknown) => {
    process.stderr.write(
      `Codex smoke failed: ${
        error instanceof Error ? error.message : "Unknown error"
      }\n`,
    );
    process.exitCode = 1;
  });
}
