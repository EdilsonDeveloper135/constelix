import { parentPort } from "node:worker_threads";
import {
  analyzeFiles,
  type AnalysisResult,
  type AnalyzeFilesOptions,
  type SourceFileInput,
} from "@constelix/analyzers";

interface AnalyzeRequest {
  id: number;
  files: SourceFileInput[];
  options: AnalyzeFilesOptions;
}

interface AnalyzeResponse {
  id: number;
  result?: AnalysisResult;
  error?: { message: string; stack?: string };
}

const port = parentPort;
if (port === null) {
  throw new Error("The analyzer worker must run inside a worker thread.");
}

port.on("message", (request: AnalyzeRequest) => {
  try {
    const result = analyzeFiles(request.files, request.options);
    port.postMessage({ id: request.id, result } satisfies AnalyzeResponse);
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    port.postMessage({
      id: request.id,
      error: {
        message: normalized.message,
        ...(normalized.stack === undefined ? {} : { stack: normalized.stack }),
      },
    } satisfies AnalyzeResponse);
  }
});
