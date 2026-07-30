import { EventEmitter } from "node:events";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createLspEnvironment,
  frameLspMessage,
  LspContentLengthParser,
  LspManager,
  LspProtocolError,
  LspSessionLimitError,
  LspUnavailableError,
  LspUriMapper,
  type LspChildProcess,
  type LspServerFamily,
  type LspSpawnOptions,
  type LspWebSocket,
} from "./lsp.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("LSP Content-Length framing", () => {
  it("decodes fragmented and concatenated UTF-8 messages by byte length", () => {
    const parser = new LspContentLengthParser();
    const first = JSON.stringify({
      jsonrpc: "2.0",
      method: "window/logMessage",
      params: { message: "área ∑" },
    });
    const second = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      result: { ready: true },
    });
    const stream = Buffer.concat([
      frameLspMessage(first),
      frameLspMessage(second),
    ]);

    expect(parser.push(stream.subarray(0, 7))).toEqual([]);
    expect(parser.push(stream.subarray(7, 29))).toEqual([]);
    const messages = parser.push(stream.subarray(29));

    expect(messages.map((message) => message.toString("utf8"))).toEqual([
      first,
      second,
    ]);
    expect(
      frameLspMessage(first)
        .subarray(0, frameLspMessage(first).indexOf("\r\n\r\n"))
        .toString("ascii"),
    ).toContain(`Content-Length: ${Buffer.byteLength(first, "utf8")}`);
  });

  it("rejects missing, duplicate, malformed, and oversized lengths", () => {
    const missing = new LspContentLengthParser();
    expect(() =>
      missing.push(
        Buffer.from("Content-Type: application/json\r\n\r\n{}", "utf8"),
      ),
    ).toThrow(LspProtocolError);

    const duplicate = new LspContentLengthParser();
    expect(() =>
      duplicate.push(
        Buffer.from(
          "Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
          "utf8",
        ),
      ),
    ).toThrow(/Content-Length/u);

    const malformed = new LspContentLengthParser();
    expect(() =>
      malformed.push(
        Buffer.from("Content-Length: 2.5\r\n\r\n{}", "utf8"),
      ),
    ).toThrow(/Content-Length/u);

    const oversized = new LspContentLengthParser(4);
    expect(() =>
      oversized.push(
        Buffer.from("Content-Length: 5\r\n\r\n12345", "utf8"),
      ),
    ).toThrow(/size limit/u);
  });

  it("bounds an unterminated header", () => {
    const parser = new LspContentLengthParser(1_024, 16);
    expect(() =>
      parser.push(Buffer.from("Content-Length: 100000", "ascii")),
    ).toThrow(/header exceeds/u);
  });

  it("decodes a large body fragmented into single-byte chunks", () => {
    const parser = new LspContentLengthParser();
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 17,
      result: "x".repeat(32 * 1024),
    });
    const framed = frameLspMessage(payload);
    const messages: Buffer[] = [];

    for (const byte of framed) {
      messages.push(...parser.push(Uint8Array.of(byte)));
    }

    expect(messages.map((message) => message.toString("utf8"))).toEqual([
      payload,
    ]);
  });
});

describe("LSP URI mapping", () => {
  it("maps spaces and Unicode without exposing the workspace root", async () => {
    const root = await temporaryDirectory("constelix-lsp-uri-");
    await mkdir(join(root, "src"), { recursive: true });
    const file = join(root, "src", "área test.ts");
    await writeFile(file, "export const área = true;\n");
    const mapper = new LspUriMapper(root, "workspace-id");

    const serverUri = mapper.toServerUri(
      "constelix://workspace-id/src/%C3%A1rea%20test.ts",
    );
    expect(serverUri).toBe(pathToFileURL(file).href);
    expect(mapper.toClientUri(serverUri)).toBe(
      "constelix://workspace-id/src/%C3%A1rea%20test.ts",
    );
    expect(mapper.toClientUri(serverUri)).not.toContain(root);
  });

  it("rejects traversal, foreign workspaces, raw file URIs, and external symlinks", async () => {
    const root = await temporaryDirectory("constelix-lsp-safe-");
    const outside = await temporaryDirectory("constelix-lsp-outside-");
    await writeFile(join(outside, "secret.ts"), "export const secret = 1;\n");
    await symlink(join(outside, "secret.ts"), join(root, "escape.ts"));
    const mapper = new LspUriMapper(root, "workspace-id");

    expect(() =>
      mapper.toServerUri(
        "constelix://workspace-id/%2e%2e/secret.ts",
      ),
    ).toThrow(/escapes/u);
    expect(() =>
      mapper.toServerUri("constelix://another-workspace/main.ts"),
    ).toThrow(/another workspace/u);
    expect(() =>
      mapper.toServerUri("constelix://workspace-id/escape.ts"),
    ).toThrow(/outside/u);
    expect(
      mapper.toClientUri(pathToFileURL(join(outside, "secret.ts")).href),
    ).toBeUndefined();
    expect(() =>
      mapper.mapClientMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: pathToFileURL(join(root, "main.ts")).href,
          },
        },
      }),
    ).toThrow(/Raw file URIs/u);
    expect(() =>
      mapper.mapClientMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: `FILE://${join(root, "main.ts")}`,
          },
        },
      }),
    ).toThrow(/Raw file URIs/u);
  });

  it("rewrites only URI fields and leaves document text unchanged", async () => {
    const root = await temporaryDirectory("constelix-lsp-text-");
    await writeFile(join(root, "main.ts"), "export const main = true;\n");
    const mapper = new LspUriMapper(root, "workspace-id");
    const source = "const example = 'file:///tmp/not-a-document-uri';";

    const mapped = mapper.mapClientMessage({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: "constelix://workspace-id/main.ts",
          languageId: "typescript",
          text: source,
        },
      },
    });

    expect(mapped).toMatchObject({
      params: {
        textDocument: {
          uri: pathToFileURL(join(root, "main.ts")).href,
          text: source,
        },
      },
    });
  });

  it("filters external locations from server responses", async () => {
    const root = await temporaryDirectory("constelix-lsp-filter-");
    const outside = await temporaryDirectory("constelix-lsp-sdk-");
    await writeFile(join(root, "main.ts"), "export const main = true;\n");
    await writeFile(join(outside, "lib.d.ts"), "declare const external: 1;\n");
    const mapper = new LspUriMapper(root, "workspace-id");

    const mapped = mapper.mapServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: [
        {
          uri: pathToFileURL(join(root, "main.ts")).href,
          range: range(),
        },
        {
          uri: pathToFileURL(join(outside, "lib.d.ts")).href,
          range: range(),
        },
      ],
    });

    expect(mapped).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: [
        {
          uri: "constelix://workspace-id/main.ts",
          range: range(),
        },
      ],
    });
    expect(JSON.stringify(mapped)).not.toContain(outside);
  });
});

describe("LspManager", () => {
  it("reports deterministic capabilities and spawns one process per family with a safe environment", async () => {
    const fixture = await createManagerFixture();
    const typescriptSocket = new FakeSocket();
    const pythonSocket = new FakeSocket();

    expect(fixture.manager.availability()).toEqual({
      javascript: {
        available: true,
        implementation: "typescript-language-server",
      },
      typescript: {
        available: true,
        implementation: "typescript-language-server",
      },
      python: { available: true, implementation: "pyright" },
    });

    await fixture.manager.attach(typescriptSocket, "javascript");
    await expect(
      fixture.manager.attach(new FakeSocket(), "typescript"),
    ).rejects.toBeInstanceOf(LspSessionLimitError);
    await fixture.manager.attach(pythonSocket, "python");

    expect(fixture.spawns).toHaveLength(2);
    expect(fixture.spawns[0]).toMatchObject({
      command: process.execPath,
      args: [fixture.typescriptEntry, "--stdio"],
      options: { cwd: fixture.root },
    });
    expect(fixture.spawns[1]).toMatchObject({
      command: process.execPath,
      args: [fixture.pythonEntry, "--stdio"],
      options: { cwd: fixture.root },
    });
    for (const spawn of fixture.spawns) {
      expect(spawn.options.env.CONSTELIX_WORKSPACE).toBe(fixture.root);
      expect(spawn.options.env).not.toHaveProperty("OPENAI_API_KEY");
      expect(spawn.options.env).not.toHaveProperty("CONSTELIX_CAPABILITY_TOKEN");
    }

    await fixture.manager.close();
    expect(fixture.processes.every((child) =>
      child.killSignals.includes("SIGTERM"),
    )).toBe(true);
  });

  it("degrades cleanly when packaged language-server entries are unavailable", async () => {
    const root = await temporaryDirectory("constelix-lsp-missing-");
    const manager = new LspManager({
      workspaceRoot: root,
      workspaceId: "workspace-id",
      resolveServerEntry: () => undefined,
    });

    expect(manager.availability()).toMatchObject({
      typescript: { available: false },
      javascript: { available: false },
      python: { available: false },
    });
    await expect(
      manager.attach(new FakeSocket(), "python"),
    ).rejects.toBeInstanceOf(LspUnavailableError);
    await manager.close();
  });

  it("proxies JSON-RPC between WebSocket and stdio while rewriting internal URIs", async () => {
    const fixture = await createManagerFixture();
    await mkdir(join(fixture.root, "src"), { recursive: true });
    const file = join(fixture.root, "src", "main.ts");
    await writeFile(file, "export const main = true;\n");
    const socket = new FakeSocket();
    await fixture.manager.attach(socket, "typescript");
    const child = fixture.processes[0]!;

    socket.receive({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        rootPath: "/",
        rootUri: "constelix://workspace/",
        initializationOptions: {
          npmLocation: "/tmp/untrusted-npm",
          plugins: [{ name: "untrusted-plugin" }],
          tsserver: { path: join(fixture.root, "node_modules/typescript") },
        },
      },
    });
    socket.receive({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: "constelix://workspace-id/src/main.ts",
          languageId: "typescript",
          version: 1,
          text: "export const main = true;\n",
        },
      },
    });

    const clientMessages = decodeFramed(child.stdin.writes);
    expect(clientMessages).toHaveLength(2);
    expect(clientMessages[0]).toMatchObject({
      method: "initialize",
      params: {
        rootPath: null,
        rootUri: pathToFileURL(fixture.root).href,
        workspaceFolders: [{
          name: "workspace",
          uri: pathToFileURL(fixture.root).href,
        }],
        initializationOptions: {
          disableAutomaticTypingAcquisition: true,
          plugins: [],
          tsserver: {
            path: fixture.typeScriptServerEntry,
            fallbackPath: fixture.typeScriptServerEntry,
          },
        },
      },
    });
    expect(JSON.stringify(clientMessages[0])).not.toContain(
      "untrusted-plugin",
    );
    expect(JSON.stringify(clientMessages[0])).not.toContain(
      "untrusted-npm",
    );
    expect(clientMessages[1]).toMatchObject({
      method: "textDocument/didOpen",
      params: {
        textDocument: { uri: pathToFileURL(file).href },
      },
    });

    const diagnostics = JSON.stringify({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: pathToFileURL(file).href,
        diagnostics: [
          {
            range: range(),
            severity: 1,
            message: `Error in ${fixture.root}/src/main.ts`,
          },
        ],
      },
    });
    const response = JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      result: {
        uri: pathToFileURL(file).href,
        range: range(),
      },
    });
    const stream = Buffer.concat([
      frameLspMessage(diagnostics),
      frameLspMessage(response),
    ]);
    child.stdout.write(stream.subarray(0, 19));
    child.stdout.write(stream.subarray(19));
    await nextTurn();

    expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
      {
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri: "constelix://workspace-id/src/main.ts",
          diagnostics: [
            {
              range: range(),
              severity: 1,
              message: "Error in <workspace>/src/main.ts",
            },
          ],
        },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        result: {
          uri: "constelix://workspace-id/src/main.ts",
          range: range(),
        },
      },
    ]);
    await fixture.manager.close();
  });

  it("rejects malformed and oversized browser messages without forwarding them", async () => {
    const fixture = await createManagerFixture({
      maxClientMessageBytes: 64,
    });
    const socket = new FakeSocket();
    await fixture.manager.attach(socket, "typescript");
    const child = fixture.processes[0]!;

    socket.receive({ protocolVersion: 1, type: "not-json-rpc" });
    await nextTurn();

    expect(socket.closes).toContainEqual({
      code: 1002,
      reason: "Invalid LSP message",
    });
    expect(child.stdin.writes).toEqual([]);
    expect(child.killSignals).toContain("SIGTERM");

    const replacement = new FakeSocket();
    await fixture.manager.attach(replacement, "typescript");
    replacement.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "x",
        params: "x".repeat(100),
      }),
    );
    await nextTurn();
    expect(replacement.closes.at(-1)?.code).toBe(1002);
    await fixture.manager.close();
  });

  it("rejects browser methods outside the read-only Constelix LSP surface", async () => {
    const fixture = await createManagerFixture();
    const socket = new FakeSocket();
    await fixture.manager.attach(socket, "typescript");
    const child = fixture.processes[0]!;

    socket.receive({
      jsonrpc: "2.0",
      id: 9,
      method: "workspace/executeCommand",
      params: {
        command: "typescript.tsserverRequest",
        arguments: ["openExternalProject"],
      },
    });
    await nextTurn();

    expect(socket.closes).toContainEqual({
      code: 1002,
      reason: "Invalid LSP message",
    });
    expect(child.stdin.writes).toEqual([]);
    expect(child.killSignals).toContain("SIGTERM");
    await fixture.manager.close();
  });

  it("closes a session when browser output backpressure exceeds its bound", async () => {
    const fixture = await createManagerFixture({
      maxPendingOutputBytes: 32,
    });
    const socket = new FakeSocket();
    await fixture.manager.attach(socket, "typescript");
    const child = fixture.processes[0]!;

    socket.bufferedAmount = 32;
    child.stdout.write(
      frameLspMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "window/logMessage",
          params: { type: 3, message: "ready" },
        }),
      ),
    );
    await nextTurn();

    expect(socket.sent).toEqual([]);
    expect(socket.closes).toContainEqual({
      code: 1011,
      reason: "Invalid language-server response",
    });
    expect(child.killSignals).toContain("SIGTERM");
    await fixture.manager.close();
  });

  it("escalates shutdown to SIGKILL and remains idempotent", async () => {
    const fixture = await createManagerFixture({
      shutdownTimeoutMs: 5,
      exitOnSigterm: false,
    });
    const socket = new FakeSocket();
    await fixture.manager.attach(socket, "python");
    const child = fixture.processes[0]!;

    const first = fixture.manager.close();
    const second = fixture.manager.close();
    expect(second).toBe(first);
    await first;

    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(socket.closes).toEqual([
      { code: 1001, reason: "Constelix is shutting down" },
    ]);
  });

  it("allows a new family session after the prior socket closes", async () => {
    const fixture = await createManagerFixture();
    const first = new FakeSocket();
    await fixture.manager.attach(first, "typescript");
    first.peerClose();
    await nextTurn();

    await expect(
      fixture.manager.attach(new FakeSocket(), "javascript"),
    ).resolves.toBeUndefined();
    await fixture.manager.close();
  });
});

describe("LSP child environment", () => {
  it("copies only the runtime allowlist", () => {
    const environment = createLspEnvironment("/workspace", {
      HOME: "/Users/developer",
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      OPENAI_API_KEY: "sk-test-only-secret",
      CONSTELIX_CAPABILITY_TOKEN: "capability-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      NODE_OPTIONS: "--require malicious.js",
    });

    expect(environment).toEqual({
      CONSTELIX_WORKSPACE: "/workspace",
      NO_COLOR: "1",
      HOME: "/Users/developer",
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin:/bin",
    });
  });
});

class FakeSocket extends EventEmitter implements LspWebSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closes.push({
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    });
    queueMicrotask(() => this.emit("close"));
  }

  receive(value: unknown): void {
    const data =
      typeof value === "string" ? value : JSON.stringify(value);
    this.emit("message", Buffer.from(data, "utf8"));
  }

  peerClose(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
}

class FakeWritable extends EventEmitter {
  readonly writes: Buffer[] = [];
  ended = false;
  acceptWrites = true;

  write(data: Uint8Array): boolean {
    this.writes.push(Buffer.from(data));
    return this.acceptWrites;
  }

  end(): void {
    this.ended = true;
  }
}

class FakeProcess extends EventEmitter implements LspChildProcess {
  readonly stdin = new FakeWritable();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: NodeJS.Signals[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(readonly exitOnSigterm = true) {
    super();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killSignals.push(signal);
    if (signal === "SIGKILL" || this.exitOnSigterm) {
      this.finish(null, signal);
    }
    return true;
  }

  finish(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

interface ManagerFixture {
  root: string;
  typescriptEntry: string;
  typeScriptServerEntry: string;
  pythonEntry: string;
  manager: LspManager;
  processes: FakeProcess[];
  spawns: Array<{
    command: string;
    args: readonly string[];
    options: LspSpawnOptions;
  }>;
}

async function createManagerFixture(options: {
  shutdownTimeoutMs?: number;
  maxClientMessageBytes?: number;
  maxPendingOutputBytes?: number;
  exitOnSigterm?: boolean;
} = {}): Promise<ManagerFixture> {
  const root = await temporaryDirectory("constelix-lsp-manager-");
  const typescriptEntry = join(root, "typescript-language-server.mjs");
  const typeScriptServerEntry = join(root, "trusted-tsserver.js");
  const pythonEntry = join(root, "pyright-langserver.js");
  await Promise.all([
    writeFile(typescriptEntry, "// fixture\n"),
    writeFile(typeScriptServerEntry, "// trusted fixture\n"),
    writeFile(pythonEntry, "// fixture\n"),
  ]);
  const processes: FakeProcess[] = [];
  const spawns: ManagerFixture["spawns"] = [];
  const managerOptions: ConstructorParameters<typeof LspManager>[0] = {
    workspaceRoot: root,
    workspaceId: "workspace-id",
    resolveServerEntry: (family: LspServerFamily) =>
      family === "typescript" ? typescriptEntry : pythonEntry,
    resolveTypeScriptServerEntry: () => typeScriptServerEntry,
    spawnProcess: (command, args, spawnOptions) => {
      spawns.push({ command, args, options: spawnOptions });
      const processHandle = new FakeProcess(
        options.exitOnSigterm ?? true,
      );
      processes.push(processHandle);
      return processHandle;
    },
    ...(options.shutdownTimeoutMs === undefined
      ? {}
      : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
    ...(options.maxClientMessageBytes === undefined
      ? {}
      : { maxClientMessageBytes: options.maxClientMessageBytes }),
    ...(options.maxPendingOutputBytes === undefined
      ? {}
      : { maxPendingOutputBytes: options.maxPendingOutputBytes }),
  };
  const manager = new LspManager(managerOptions);
  return {
    root,
    typescriptEntry,
    typeScriptServerEntry,
    pythonEntry,
    manager,
    processes,
    spawns,
  };
}

function decodeFramed(chunks: readonly Buffer[]): unknown[] {
  const parser = new LspContentLengthParser();
  return chunks
    .flatMap((chunk) => parser.push(chunk))
    .map((body) => JSON.parse(body.toString("utf8")) as unknown);
}

function range() {
  return {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 4 },
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), prefix));
  const root = await realpath(created);
  temporaryRoots.push(root);
  return root;
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
}
