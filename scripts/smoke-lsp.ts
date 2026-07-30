import { EventEmitter } from "node:events";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LspManager } from "../apps/agent/src/lsp.js";
import { createWorkspaceId } from "../apps/agent/src/security.js";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

class SmokeSocket extends EventEmitter {
  readyState = 1;
  readonly received: JsonRpcMessage[] = [];

  send(serialized: string): void {
    const message = JSON.parse(serialized) as JsonRpcMessage;
    this.received.push(message);
    this.emit("server-message", message);
    if (message.method && message.id !== undefined) {
      const result =
        message.method === "workspace/configuration" &&
        isRecord(message.params) &&
        Array.isArray(message.params.items)
          ? message.params.items.map(() => ({}))
          : message.method === "workspace/applyEdit"
            ? { applied: false }
            : null;
      queueMicrotask(() => {
        this.clientSend({ jsonrpc: "2.0", id: message.id, result });
      });
    }
  }

  clientSend(message: JsonRpcMessage): void {
    this.emit("message", JSON.stringify(message));
  }

  close(): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.emit("close");
  }

  waitFor(
    predicate: (message: JsonRpcMessage) => boolean,
    timeoutMs = 15_000,
    label = "LSP response",
  ): Promise<JsonRpcMessage> {
    const existing = this.received.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveWait, rejectWait) => {
      const timer = setTimeout(() => {
        this.off("server-message", onMessage);
        rejectWait(
          new Error(
            `Timed out waiting for ${label}. Received: ${JSON.stringify(this.received)}`,
          ),
        );
      }, timeoutMs);
      const onMessage = (message: JsonRpcMessage) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        this.off("server-message", onMessage);
        resolveWait(message);
      };
      this.on("server-message", onMessage);
    });
  }
}

const workspaceRoot = await mkdtemp(
  join(tmpdir(), "constelix-lsp-smoke-"),
);

try {
  await Promise.all([
    writeFile(
      join(workspaceRoot, "dependency.ts"),
      "export function greet(name: string): string { return `Hello ${name}`; }\n",
    ),
    writeFile(
      join(workspaceRoot, "main.ts"),
      [
        'import { greet } from "./dependency";',
        'const output = greet("Constelix");',
        'const broken: number = "not-a-number";',
        "console.log(output, broken);",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(workspaceRoot, "helpers.py"),
      "def greet(name: str) -> str:\n    return f\"Hello {name}\"\n",
    ),
    writeFile(
      join(workspaceRoot, "main.py"),
      [
        "from helpers import greet",
        'value: int = "not-a-number"',
        'result = greet("Constelix")',
        "",
      ].join("\n"),
    ),
  ]);
  const canonicalRoot = await realpath(workspaceRoot);
  const workspaceId = createWorkspaceId(canonicalRoot);
  const manager = new LspManager({ workspaceRoot, workspaceId });
  const availability = manager.availability();
  if (!availability.typescript.available || !availability.python.available) {
    throw new Error(
      `Bundled LSP unavailable: ${JSON.stringify(availability)}`,
    );
  }

  try {
    await smokeLanguage(manager, new SmokeSocket(), {
      language: "typescript",
      languageId: "typescript",
      workspaceId,
      relativePath: "main.ts",
      hoverPosition: { line: 1, character: 16 },
      requireDiagnostics: true,
    });
    await smokeLanguage(manager, new SmokeSocket(), {
      language: "python",
      languageId: "python",
      workspaceId,
      relativePath: "main.py",
      hoverPosition: { line: 2, character: 10 },
      requireDiagnostics: true,
    });
  } finally {
    await manager.close();
  }

  process.stdout.write(
    "LSP smoke passed: TypeScript and Pyright initialized, diagnosed, and answered hover requests.\n",
  );
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
}

async function smokeLanguage(
  manager: LspManager,
  socket: SmokeSocket,
  options: {
    language: "typescript" | "python";
    languageId: string;
    workspaceId: string;
    relativePath: string;
    hoverPosition: { line: number; character: number };
    requireDiagnostics: boolean;
  },
): Promise<void> {
  await manager.attach(socket as never, options.language);
  socket.clientSend({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      processId: null,
      rootUri: "constelix://workspace/",
      workspaceFolders: [
        { uri: "constelix://workspace/", name: "workspace" },
      ],
      capabilities: {
        workspace: { configuration: true },
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          publishDiagnostics: { versionSupport: true },
        },
      },
    },
  });
  const initialized = await socket.waitFor(
    (message) => message.id === 1,
    15_000,
    `${options.language} initialize`,
  );
  if (initialized.error || !Object.hasOwn(initialized, "result")) {
    throw new Error(`${options.language} LSP initialization failed.`);
  }
  socket.clientSend({
    jsonrpc: "2.0",
    method: "initialized",
    params: {},
  });
  const uri = constelixUri(options.workspaceId, options.relativePath);
  socket.clientSend({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri,
        languageId: options.languageId,
        version: 1,
        text: await readFile(
          join(workspaceRoot, options.relativePath),
          "utf8",
        ),
      },
    },
  });
  if (options.requireDiagnostics) {
    const diagnostics = await socket.waitFor(
      (message) =>
        message.method === "textDocument/publishDiagnostics" &&
        isRecord(message.params) &&
        message.params.uri === uri &&
        Array.isArray(message.params.diagnostics) &&
        message.params.diagnostics.length > 0,
      15_000,
      `${options.language} diagnostics`,
    );
    if (!diagnostics) {
      throw new Error(`${options.language} did not publish diagnostics.`);
    }
  }
  socket.clientSend({
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/hover",
    params: {
      textDocument: { uri },
      position: options.hoverPosition,
    },
  });
  const hover = await socket.waitFor(
    (message) => message.id === 2,
    15_000,
    `${options.language} hover`,
  );
  if (hover.error || hover.result === null || hover.result === undefined) {
    throw new Error(`${options.language} did not return hover information.`);
  }
  socket.clientSend({
    jsonrpc: "2.0",
    method: "textDocument/didClose",
    params: { textDocument: { uri } },
  });
  socket.close();
}

function constelixUri(
  workspaceId: string,
  relativePath: string,
): string {
  return `constelix://${workspaceId}/${relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
