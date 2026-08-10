import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api.js";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/python/register.js";
import "monaco-editor/languages/definitions/typescript/register.js";

interface MonacoWorkerEnvironment {
  getWorker(moduleId: string, label: string): Worker;
}

const workerScope = self as typeof self & { MonacoEnvironment?: MonacoWorkerEnvironment };

workerScope.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  }
};

loader.config({ monaco });

export function getLocalMonaco(): typeof monaco {
  return monaco;
}
