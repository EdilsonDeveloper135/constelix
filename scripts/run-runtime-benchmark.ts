import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { EventBus } from "../apps/agent/src/events.js";
import { TerminalManager } from "../apps/agent/src/terminals.js";

const PTY_SAMPLES = 20;
const PTY_P95_BUDGET_MS = 100;
const workspaceRoot = await mkdtemp(
  join(tmpdir(), "constelix-runtime-benchmark-"),
);
const events = new EventBus();
const terminals = new TerminalManager(workspaceRoot, events);

try {
  const session = await terminals.create({ cwd: ".", cols: 100, rows: 30 });

  const latencies: number[] = [];
  for (let sample = 0; sample < PTY_SAMPLES; sample += 1) {
    const marker = `CONSTELIX_PTY_${sample}_${Date.now()}`;
    const startedAt = performance.now();
    const observed = waitForTerminalOutput(
      events,
      session.id,
      (output) => output.includes(marker),
      5_000,
    );
    terminals.write(session.id, `printf '%s\\n' '${marker}'\r`);
    await observed;
    latencies.push(performance.now() - startedAt);
  }

  const p95Ms = percentile(latencies, 0.95);
  const result = {
    samples: latencies.map(Math.round),
    p95Ms: Math.round(p95Ms),
    budgetMs: PTY_P95_BUDGET_MS,
    passed: p95Ms <= PTY_P95_BUDGET_MS,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (p95Ms > PTY_P95_BUDGET_MS) {
    throw new Error(`PTY latency p95 exceeded ${PTY_P95_BUDGET_MS} ms.`);
  }
} finally {
  terminals.close();
  events.close();
  await rm(workspaceRoot, { recursive: true, force: true });
}

function waitForTerminalOutput(
  events: EventBus,
  terminalId: string,
  predicate: (output: string) => boolean,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`PTY output did not match within ${timeoutMs} ms.`));
    }, timeoutMs);
    timeout.unref();
    const unsubscribe = events.subscribe((event) => {
      if (event.type !== "terminal.output") return;
      const payload = event.payload as { terminalId?: string; data?: string };
      if (payload.terminalId !== terminalId || payload.data === undefined) return;
      output += payload.data;
      if (!predicate(output)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
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
