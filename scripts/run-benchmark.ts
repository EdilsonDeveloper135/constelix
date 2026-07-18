import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { startAgentServer } from "../apps/agent/src/server.js";
import {
  generateBenchmarkFixture,
  LINES_PER_BENCHMARK_FILE,
} from "./generate-benchmark.js";

const FILE_COUNT = 10_000;
const COLD_BUDGET_MS = 90_000;
const INCREMENTAL_BUDGET_MS = 1_000;
const INCREMENTAL_SAMPLES = 20;
const fixture = await generateBenchmarkFixture(FILE_COUNT);
const stateDirectory = await mkdtemp(join(tmpdir(), "constelix-benchmark-state-"));
const startedAt = performance.now();
const server = await startAgentServer({
  workspaceRoot: fixture,
  capabilityToken: "constelix-benchmark-capability",
  storageDirectory: stateDirectory,
  databasePath: join(stateDirectory, "benchmark.sqlite"),
  webDistPath: join(stateDirectory, "no-web-assets"),
  indexerScanOptions: { maxTotalBytes: 256 * 1024 * 1024 },
  port: 0
});

try {
  const coldStatus = await waitForReady(server, 0, COLD_BUDGET_MS + 5_000);
  const coldMs = performance.now() - startedAt;
  const headers = {
    authorization: `Bearer ${server.capabilityToken}`,
    host: `127.0.0.1:${server.port}`,
    "content-type": "application/json",
  };
  const incrementalSamplesMs: number[] = [];
  let latestRevision = coldStatus.revision;
  for (let sample = 0; sample < INCREMENTAL_SAMPLES; sample += 1) {
    const relativePath = `src/module-${5_000 + sample}.js`;
    const read = await server.app.inject({
      method: "POST",
      url: "/api/v1/files/read",
      headers,
      payload: { protocolVersion: 1, relativePath },
    });
    if (read.statusCode !== 200) {
      throw new Error(`Benchmark editor read failed with HTTP ${read.statusCode}: ${read.body}`);
    }
    const opened = read.json<{ content: string; contentHash: string }>();
    const incrementalStartedAt = performance.now();
    const write = await server.app.inject({
      method: "PUT",
      url: "/api/v1/files/write",
      headers,
      payload: {
        protocolVersion: 1,
        relativePath,
        content: `${opened.content}\nexport const benchmarkChange${sample} = true;\n`,
        expectedContentHash: opened.contentHash,
      },
    });
    if (write.statusCode !== 200) {
      throw new Error(`Benchmark editor write failed with HTTP ${write.statusCode}: ${write.body}`);
    }
    const incrementalStatus = await waitForReady(
      server,
      latestRevision,
      Math.max(5_000, INCREMENTAL_BUDGET_MS * 3),
    );
    incrementalSamplesMs.push(performance.now() - incrementalStartedAt);
    latestRevision = incrementalStatus.revision;
  }
  const incrementalP95Ms = percentile(incrementalSamplesMs, 0.95);
  const result = {
    files: coldStatus.total,
    lines: FILE_COUNT * LINES_PER_BENCHMARK_FILE,
    coldMs: Math.round(coldMs),
    coldBudgetMs: COLD_BUDGET_MS,
    incrementalSamplesMs: incrementalSamplesMs.map(Math.round),
    incrementalP95Ms: Math.round(incrementalP95Ms),
    incrementalBudgetMs: INCREMENTAL_BUDGET_MS,
    revisions: { cold: coldStatus.revision, incremental: latestRevision },
    passed: coldMs <= COLD_BUDGET_MS && incrementalP95Ms <= INCREMENTAL_BUDGET_MS
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (coldStatus.total !== FILE_COUNT) throw new Error(`Expected ${FILE_COUNT} indexed files, received ${coldStatus.total}.`);
  if (coldMs > COLD_BUDGET_MS) throw new Error(`Cold index exceeded ${COLD_BUDGET_MS} ms.`);
  if (incrementalP95Ms > INCREMENTAL_BUDGET_MS) {
    throw new Error(`Incremental index p95 exceeded ${INCREMENTAL_BUDGET_MS} ms.`);
  }
} finally {
  await server.close();
  await Promise.all([
    rm(fixture, { recursive: true, force: true }),
    rm(stateDirectory, { recursive: true, force: true })
  ]);
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) throw new Error("A percentile requires at least one sample.");
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1),
  );
  return sorted[index]!;
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
