import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type {
  AnalysisResult,
  AnalyzeFilesOptions,
  SourceFileInput,
} from "@constelix/analyzers";

interface AnalyzeResponse {
  id: number;
  result?: AnalysisResult;
  error?: { message: string; stack?: string };
}

interface PendingRequest {
  resolve(result: AnalysisResult): void;
  reject(error: Error): void;
}

/** A single reusable worker keeps native Tree-sitter parsing off Fastify's event loop. */
export class AnalyzerWorkerClient {
  #worker: Worker | undefined;
  #nextRequestId = 1;
  readonly #pending = new Map<number, PendingRequest>();
  #closing = false;

  analyze(
    files: readonly SourceFileInput[],
    options: AnalyzeFilesOptions,
  ): Promise<AnalysisResult> {
    if (this.#closing) return Promise.reject(new Error("The analyzer worker is closed."));
    const worker = this.ensureWorker();
    const id = this.#nextRequestId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      worker.postMessage({ id, files, options });
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    const worker = this.#worker;
    this.#worker = undefined;
    if (worker !== undefined) await worker.terminate();
    this.rejectPending(new Error("The analyzer worker was closed."));
  }

  private ensureWorker(): Worker {
    if (this.#worker !== undefined) return this.#worker;
    const compiledUrl = new URL("./analyzer-worker.js", import.meta.url);
    const useSource = !existsSync(fileURLToPath(compiledUrl));
    const worker = new Worker(
      useSource ? new URL("./analyzer-worker.ts", import.meta.url) : compiledUrl,
      {
        // Source-mode is used by tsx/Vitest; packaged builds use the emitted JS entry.
        execArgv: useSource ? ["--import", "tsx"] : [],
      },
    );
    worker.on("message", (response: AnalyzeResponse) => {
      const pending = this.#pending.get(response.id);
      if (pending === undefined) return;
      this.#pending.delete(response.id);
      if (response.error !== undefined) {
        const error = new Error(response.error.message);
        if (response.error.stack !== undefined) error.stack = response.error.stack;
        pending.reject(error);
      } else if (response.result !== undefined) {
        pending.resolve(response.result);
      } else {
        pending.reject(new Error("The analyzer worker returned an invalid response."));
      }
    });
    worker.on("error", (error) => {
      this.#worker = undefined;
      this.rejectPending(error);
    });
    worker.on("exit", (code) => {
      if (this.#worker === worker) this.#worker = undefined;
      if (!this.#closing && code !== 0) {
        this.rejectPending(new Error(`The analyzer worker exited with code ${code}.`));
      }
    });
    this.#worker = worker;
    return worker;
  }

  private rejectPending(error: Error): void {
    for (const request of this.#pending.values()) request.reject(error);
    this.#pending.clear();
  }
}
