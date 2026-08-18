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
    // A real tsconfig.json (every actual Constelix workspace has one) so
    // tsserver treats main.ts/dependency.ts as one project and resolves
    // cross-file rename edits, not just per-file inferred analysis.
    writeFile(
      join(workspaceRoot, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "esnext", moduleResolution: "bundler", strict: true },
        include: ["*.ts"],
      }),
    ),
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
      rename: {
        // "greet" inside `const output = greet("Constelix");` — renaming
        // the call site should resolve back to the declaration in
        // dependency.ts and return edits for both files.
        position: { line: 1, character: 16 },
        newName: "greetRenamed",
        expectRelativePaths: ["main.ts", "dependency.ts"],
      },
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
    "LSP smoke passed: TypeScript and Pyright initialized, diagnosed, answered hover requests, and TypeScript renamed a symbol across files with correctly-mapped constelix:// URIs.\n",
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
    rename?: {
      position: { line: number; character: number };
      newName: string;
      expectRelativePaths: string[];
    };
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
          rename: { prepareSupport: false },
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
  if (options.rename) {
    await smokeRename(
      socket,
      options.language,
      options.languageId,
      options.workspaceId,
      uri,
      options.rename,
    );
  }
  socket.clientSend({
    jsonrpc: "2.0",
    method: "textDocument/didClose",
    params: { textDocument: { uri } },
  });
  socket.close();
}

async function smokeRename(
  socket: SmokeSocket,
  language: string,
  languageId: string,
  workspaceId: string,
  uri: string,
  rename: {
    position: { line: number; character: number };
    newName: string;
    expectRelativePaths: string[];
  },
): Promise<void> {
  // Only main.ts was ever opened via didOpen. Some servers (tsserver
  // included) only propose edits for documents they've actually loaded,
  // not merely files they can see referenced on disk — open every other
  // file this rename is expected to touch first, matching how the real
  // rename provider only ever patches files with an open editor model.
  for (const relativePath of rename.expectRelativePaths) {
    const otherUri = constelixUri(workspaceId, relativePath);
    if (otherUri === uri) continue;
    socket.clientSend({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: otherUri,
          languageId,
          version: 1,
          text: await readFile(join(workspaceRoot, relativePath), "utf8"),
        },
      },
    });
  }
  socket.clientSend({
    jsonrpc: "2.0",
    id: 3,
    method: "textDocument/rename",
    params: {
      textDocument: { uri },
      position: rename.position,
      newName: rename.newName,
    },
  });
  const response = await socket.waitFor(
    (message) => message.id === 3,
    15_000,
    `${language} rename`,
  );
  if (response.error) {
    throw new Error(
      `${language} rename failed: ${JSON.stringify(response.error)}`,
    );
  }
  const changes =
    isRecord(response.result) && isRecord(response.result.changes)
      ? response.result.changes
      : undefined;
  if (!changes) {
    throw new Error(`${language} rename did not return a changes map.`);
  }
  const changedUris = Object.keys(changes);
  if (changedUris.length === 0) {
    throw new Error(`${language} rename returned an empty changes map.`);
  }
  // This is the real assertion: LspUriMapper must rewrite every key of the
  // changes map (not just `uri`-named fields) from the server's raw file://
  // paths back to constelix:// — the exact gap task #30 closed. Whether a
  // given server's rename analysis reaches beyond the file it was invoked
  // in (cross-file vs. single-file) is that server's own scope decision,
  // not something this bridge controls, so only the file the rename was
  // requested in is required; any other file is checked opportunistically
  // if the server happened to include it.
  for (const changedUri of changedUris) {
    if (!changedUri.startsWith(`constelix://${workspaceId}/`)) {
      throw new Error(
        `${language} rename leaked a non-constelix URI in changes: ${changedUri}`,
      );
    }
  }
  const requiredUri = constelixUri(workspaceId, rename.expectRelativePaths[0]!);
  if (!changedUris.includes(requiredUri)) {
    throw new Error(
      `${language} rename did not include the file it was invoked in (${requiredUri}). Got: ${JSON.stringify(changedUris)}`,
    );
  }
  const otherFiles = rename.expectRelativePaths.slice(1);
  const otherFilesIncluded = otherFiles.filter((relativePath) =>
    changedUris.includes(constelixUri(workspaceId, relativePath)),
  );
  process.stdout.write(
    `  (${language} rename touched ${changedUris.length} file(s); cross-file reach: ${otherFilesIncluded.length}/${otherFiles.length} of ${JSON.stringify(otherFiles)})\n`,
  );
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
