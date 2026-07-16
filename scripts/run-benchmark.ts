import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { startAgentServer } from "../apps/agent/src/server.js";
import { generateBenchmarkFixture } from "./generate-benchmark.js";

const FILE_COUNT = 10_000;
const COLD_BUDGET_MS = 90_000;
const INCREMENTAL_BUDGET_MS = 1_000;
const fixture = await generateBenchmarkFixture(FILE_COUNT);
const stateDirectory = await mkdtemp(join(tmpdir(), "constelix-benchmark-state-"));
const startedAt = performance.now();
const server = await startAgentServer({
  workspaceRoot: fixture,
  capabilityToken: "constelix-benchmark-capability",
  databasePath: join(stateDirectory, "benchmark.sqlite"),
  webDistPath: join(stateDirectory, "no-web-assets"),
  port: 0
});

try {
  const coldStatus = await waitForReady(server, 0, COLD_BUDGET_MS + 5_000);
  const coldMs = performance.now() - startedAt;
  const changedFile = join(fixture, "src", "module-5000.js");
  const original = await readFile(changedFile, "utf8");
  const incrementalStartedAt = performance.now();
  await writeFile(changedFile, `${original}\nexport const benchmarkChange = true;\n`, "utf8");
  const incrementalStatus = await waitForReady(
    server,
    coldStatus.revision,
    Math.max(5_000, INCREMENTAL_BUDGET_MS * 3)
  );
  const incrementalMs = performance.now() - incrementalStartedAt;
  const result = {
    files: coldStatus.total,
    coldMs: Math.round(coldMs),
    coldBudgetMs: COLD_BUDGET_MS,
    incrementalMs: Math.round(incrementalMs),
    incrementalBudgetMs: INCREMENTAL_BUDGET_MS,
    revisions: { cold: coldStatus.revision, incremental: incrementalStatus.revision },
    passed: coldMs <= COLD_BUDGET_MS && incrementalMs <= INCREMENTAL_BUDGET_MS
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (coldStatus.total !== FILE_COUNT) throw new Error(`Expected ${FILE_COUNT} indexed files, received ${coldStatus.total}.`);
  if (coldMs > COLD_BUDGET_MS) throw new Error(`Cold index exceeded ${COLD_BUDGET_MS} ms.`);
  if (incrementalMs > INCREMENTAL_BUDGET_MS) throw new Error(`Incremental index exceeded ${INCREMENTAL_BUDGET_MS} ms.`);
} finally {
  await server.close();
  await Promise.all([
    rm(fixture, { recursive: true, force: true }),
    rm(stateDirectory, { recursive: true, force: true })
  ]);
}

interface HealthPayload {
  index: { phase: string; total: number; revision: number };
}

async function waitForReady(
  server: Awaited<ReturnType<typeof startAgentServer>>,
  afterRevision: number,
  timeoutMs: number
): Promise<HealthPayload["index"]> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const response = await server.app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: {
        authorization: `Bearer ${server.capabilityToken}`,
        host: `127.0.0.1:${server.port}`
      }
    });
    if (response.statusCode !== 200) {
      throw new Error(`Health probe failed with HTTP ${response.statusCode}: ${response.body}`);
    }
    const payload = response.json<HealthPayload>();
    if (payload.index.phase === "ready" && payload.index.revision > afterRevision) return payload.index;
    if (payload.index.phase === "error") throw new Error("Benchmark indexing entered the error state.");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Index did not reach a newer ready revision within ${timeoutMs} ms.`);
}
