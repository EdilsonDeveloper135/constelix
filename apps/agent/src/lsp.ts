import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { redactLocalPaths } from "./security.js";

export type LspLanguage = "javascript" | "typescript" | "python";
export type LspServerFamily = "typescript" | "python";

export interface LspServerCapability {
  available: boolean;
  implementation: "typescript-language-server" | "pyright";
  reason?: string;
}

export interface LspAvailability {
  javascript: LspServerCapability;
  typescript: LspServerCapability;
  python: LspServerCapability;
}

export interface LspWebSocket {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (raw: unknown) => void): void;
  once(
    event: "close" | "error",
    listener: (error?: unknown) => void,
  ): void;
  off?(event: "message", listener: (raw: unknown) => void): void;
}

interface WritableProcessStream {
  write(data: Uint8Array): boolean;
  end(): void;
  once(event: "drain", listener: () => void): void;
}

interface ReadableProcessStream {
  on(event: "data", listener: (data: Uint8Array) => void): void;
}

export interface LspChildProcess {
  readonly stdin: WritableProcessStream;
  readonly stdout: ReadableProcessStream;
  readonly stderr: ReadableProcessStream;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(
    event: "exit",
    listener: (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => void,
  ): void;
  once(event: "error", listener: (error: Error) => void): void;
}

export interface LspSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface LspManagerOptions {
  workspaceRoot: string;
  workspaceId: string;
  resolveServerEntry?: (
    family: LspServerFamily,
  ) => string | undefined;
  resolveTypeScriptServerEntry?: () => string | undefined;
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: LspSpawnOptions,
  ) => LspChildProcess;
  shutdownTimeoutMs?: number;
  maxHeaderBytes?: number;
  maxServerMessageBytes?: number;
  maxClientMessageBytes?: number;
  maxPendingInputBytes?: number;
  maxPendingOutputBytes?: number;
}

export class LspUnavailableError extends Error {
  readonly code = "LSP_UNAVAILABLE";

  constructor(readonly family: LspServerFamily, message: string) {
    super(message);
    this.name = "LspUnavailableError";
  }
}

export class LspSessionLimitError extends Error {
  readonly code = "LSP_SESSION_LIMIT";

  constructor(readonly family: LspServerFamily) {
    super(`Only one ${family} language-server session may be active.`);
    this.name = "LspSessionLimitError";
  }
}

export class LspProtocolError extends Error {
  readonly code = "LSP_PROTOCOL_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "LspProtocolError";
  }
}

const DEFAULT_MAX_HEADER_BYTES = 8 * 1024;
const DEFAULT_MAX_SERVER_MESSAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_CLIENT_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_MAX_PENDING_INPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_PENDING_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_500;
const HEADER_SEPARATOR = Buffer.from("\r\n\r\n", "ascii");
const URI_PROPERTY_NAMES = new Set([
  "documentUri",
  "newUri",
  "oldUri",
  "rootUri",
  "scopeUri",
  "target",
  "targetUri",
  "uri",
]);
const ALLOWED_CLIENT_LSP_METHODS = new Set([
  "$/cancelRequest",
  "initialize",
  "initialized",
  "textDocument/completion",
  "textDocument/definition",
  "textDocument/didChange",
  "textDocument/didClose",
  "textDocument/didOpen",
  "textDocument/hover",
  "textDocument/references",
]);
const EXTERNAL_URI = Symbol("external-lsp-uri");

interface JsonRpcEnvelope extends Record<string, unknown> {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface ResolvedLspServer {
  entryPath?: string;
  capability: LspServerCapability;
}

/**
 * Incrementally decodes the Content-Length framing used by LSP over stdio.
 * Lengths are measured in bytes, not JavaScript string code units.
 */
export class LspContentLengthParser {
  readonly #chunks: Buffer[] = [];
  #bufferedBytes = 0;
  #expectedBodyBytes: number | undefined;

  constructor(
    private readonly maxBodyBytes = DEFAULT_MAX_SERVER_MESSAGE_BYTES,
    private readonly maxHeaderBytes = DEFAULT_MAX_HEADER_BYTES,
  ) {}

  push(chunk: Uint8Array): Buffer[] {
    if (chunk.byteLength === 0) return [];
    this.#chunks.push(
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
    );
    this.#bufferedBytes += chunk.byteLength;
    const messages: Buffer[] = [];

    while (true) {
      if (this.#expectedBodyBytes === undefined) {
        const headerProbe = this.#peek(
          Math.min(
            this.#bufferedBytes,
            this.maxHeaderBytes + HEADER_SEPARATOR.byteLength,
          ),
        );
        const separatorIndex = headerProbe.indexOf(HEADER_SEPARATOR);
        if (separatorIndex === -1) {
          if (this.#bufferedBytes > this.maxHeaderBytes) {
            throw new LspProtocolError("LSP header exceeds its size limit.");
          }
          break;
        }
        if (separatorIndex > this.maxHeaderBytes) {
          throw new LspProtocolError("LSP header exceeds its size limit.");
        }
        const header = headerProbe.subarray(0, separatorIndex).toString("ascii");
        this.#expectedBodyBytes = parseContentLength(
          header,
          this.maxBodyBytes,
        );
        this.#consume(separatorIndex + HEADER_SEPARATOR.byteLength);
      }

      if (this.#bufferedBytes < this.#expectedBodyBytes) break;
      const body = this.#consume(this.#expectedBodyBytes);
      this.#expectedBodyBytes = undefined;
      messages.push(body);
    }

    return messages;
  }

  #peek(byteLength: number): Buffer {
    if (byteLength === 0) return Buffer.alloc(0);
    const first = this.#chunks[0];
    if (first && first.byteLength >= byteLength) {
      return first.subarray(0, byteLength);
    }
    const output = Buffer.allocUnsafe(byteLength);
    let offset = 0;
    for (const queued of this.#chunks) {
      const copied = Math.min(queued.byteLength, byteLength - offset);
      queued.copy(output, offset, 0, copied);
      offset += copied;
      if (offset === byteLength) break;
    }
    return output;
  }

  #consume(byteLength: number): Buffer {
    if (byteLength > this.#bufferedBytes) {
      throw new LspProtocolError("Incomplete language-server response.");
    }
    const output = Buffer.allocUnsafe(byteLength);
    let offset = 0;
    while (offset < byteLength) {
      const queued = this.#chunks[0];
      if (!queued) {
        throw new LspProtocolError("Incomplete language-server response.");
      }
      const copied = Math.min(queued.byteLength, byteLength - offset);
      queued.copy(output, offset, 0, copied);
      offset += copied;
      if (copied === queued.byteLength) {
        this.#chunks.shift();
      } else {
        this.#chunks[0] = queued.subarray(copied);
      }
    }
    this.#bufferedBytes -= byteLength;
    return output;
  }
}

export function frameLspMessage(payload: string | Uint8Array): Buffer {
  const body =
    typeof payload === "string"
      ? Buffer.from(payload, "utf8")
      : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  const header = Buffer.from(
    `Content-Length: ${body.byteLength}\r\n\r\n`,
    "ascii",
  );
  return Buffer.concat([header, body]);
}

export class LspUriMapper {
  readonly workspaceRoot: string;

  constructor(
    workspaceRoot: string,
    readonly workspaceId: string,
  ) {
    this.workspaceRoot = canonicalExistingDirectory(workspaceRoot);
    if (!workspaceId || /[/\\\0]/u.test(workspaceId)) {
      throw new LspProtocolError("The workspace id is invalid.");
    }
  }

  toServerUri(uri: string): string {
    const rawPath = rawConstelixPath(uri);
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new LspProtocolError("The client sent an invalid document URI.");
    }
    if (parsed.protocol !== "constelix:") {
      throw new LspProtocolError(
        "The client may only send constelix document URIs.",
      );
    }
    if (
      parsed.hostname !== this.workspaceId &&
      parsed.hostname !== "workspace"
    ) {
      throw new LspProtocolError(
        "The document URI belongs to another workspace.",
      );
    }
    if (parsed.search || parsed.hash) {
      throw new LspProtocolError(
        "Document URIs cannot contain a query or fragment.",
      );
    }

    const relativePath = decodeConstelixPath(rawPath);
    const candidate = resolve(this.workspaceRoot, relativePath);
    assertContained(this.workspaceRoot, candidate);
    assertCanonicalContainment(this.workspaceRoot, candidate);
    return pathToFileURL(candidate).href;
  }

  toClientUri(uri: string): string | undefined {
    let path: string;
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== "file:") return undefined;
      path = fileURLToPath(parsed);
    } catch {
      return undefined;
    }

    const candidate = resolve(path);
    if (!isContained(this.workspaceRoot, candidate)) return undefined;
    if (!hasCanonicalContainment(this.workspaceRoot, candidate)) {
      return undefined;
    }
    const relativePath = toPosixPath(relative(this.workspaceRoot, candidate));
    const encodedPath = relativePath
      .split("/")
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `constelix://${this.workspaceId}/${encodedPath}`;
  }

  mapClientMessage(message: JsonRpcEnvelope): JsonRpcEnvelope {
    return mapJsonRpcEnvelope(message, (value, property) => {
      if (!URI_PROPERTY_NAMES.has(property ?? "")) return value;
      if (/^file:/iu.test(value)) {
        throw new LspProtocolError(
          "Raw file URIs are not accepted from the browser.",
        );
      }
      if (/^constelix:/iu.test(value)) {
        return this.toServerUri(value);
      }
      return value;
    }) as JsonRpcEnvelope;
  }

  mapServerMessage(
    message: JsonRpcEnvelope,
  ): JsonRpcEnvelope | undefined {
    const mapped = mapJsonRpcEnvelope(
      message,
      (value, property) => {
        if (/^file:/iu.test(value)) {
          const internal = this.toClientUri(value);
          if (internal !== undefined) return internal;
          return URI_PROPERTY_NAMES.has(property ?? "")
            ? EXTERNAL_URI
            : "[external resource unavailable]";
        }
        return redactLocalPaths(value, this.workspaceRoot);
      },
      true,
    );
    return mapped === EXTERNAL_URI
      ? undefined
      : (mapped as JsonRpcEnvelope);
  }
}

export class LspManager {
  readonly #workspaceRoot: string;
  readonly #workspaceId: string;
  readonly #uriMapper: LspUriMapper;
  readonly #servers: Record<LspServerFamily, ResolvedLspServer>;
  readonly #spawnProcess: NonNullable<LspManagerOptions["spawnProcess"]>;
  readonly #typeScriptServerEntry: string | undefined;
  readonly #shutdownTimeoutMs: number;
  readonly #maxHeaderBytes: number;
  readonly #maxServerMessageBytes: number;
  readonly #maxClientMessageBytes: number;
  readonly #maxPendingInputBytes: number;
  readonly #maxPendingOutputBytes: number;
  readonly #sessions = new Map<LspServerFamily, LspSession>();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: LspManagerOptions) {
    this.#workspaceRoot = canonicalExistingDirectory(options.workspaceRoot);
    this.#workspaceId = options.workspaceId;
    this.#uriMapper = new LspUriMapper(
      this.#workspaceRoot,
      this.#workspaceId,
    );
    const resolver =
      options.resolveServerEntry ?? defaultResolveServerEntry;
    this.#servers = {
      typescript: resolveServer(
        "typescript",
        "typescript-language-server",
        resolver,
      ),
      python: resolveServer("python", "pyright", resolver),
    };
    this.#typeScriptServerEntry = resolveTrustedFile(
      options.resolveTypeScriptServerEntry?.() ??
        defaultResolveTypeScriptServerEntry(),
    );
    if (
      this.#servers.typescript.entryPath &&
      !this.#typeScriptServerEntry
    ) {
      this.#servers.typescript = {
        capability: {
          available: false,
          implementation: "typescript-language-server",
          reason:
            "The trusted TypeScript server is not installed in the Constelix runtime.",
        },
      };
    }
    this.#spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
    this.#shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.#maxHeaderBytes =
      options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
    this.#maxServerMessageBytes =
      options.maxServerMessageBytes ??
      DEFAULT_MAX_SERVER_MESSAGE_BYTES;
    this.#maxClientMessageBytes =
      options.maxClientMessageBytes ??
      DEFAULT_MAX_CLIENT_MESSAGE_BYTES;
    this.#maxPendingInputBytes =
      options.maxPendingInputBytes ??
      DEFAULT_MAX_PENDING_INPUT_BYTES;
    this.#maxPendingOutputBytes =
      options.maxPendingOutputBytes ??
      DEFAULT_MAX_PENDING_OUTPUT_BYTES;
  }

  availability(): LspAvailability {
    const typescript = cloneCapability(
      this.#servers.typescript.capability,
    );
    return {
      javascript: cloneCapability(typescript),
      typescript,
      python: cloneCapability(this.#servers.python.capability),
    };
  }

  async attach(
    socket: LspWebSocket,
    language: LspLanguage,
  ): Promise<void> {
    if (this.#closed) {
      throw new LspUnavailableError(
        normalizeFamily(language),
        "The LSP manager is closed.",
      );
    }
    const family = normalizeFamily(language);
    if (this.#sessions.has(family)) {
      throw new LspSessionLimitError(family);
    }
    const server = this.#servers[family];
    if (!server.entryPath) {
      throw new LspUnavailableError(
        family,
        server.capability.reason ?? `${family} LSP is unavailable.`,
      );
    }

    let child: LspChildProcess;
    try {
      child = this.#spawnProcess(
        process.execPath,
        [server.entryPath, "--stdio"],
        {
          cwd: this.#workspaceRoot,
          env: createLspEnvironment(this.#workspaceRoot),
        },
      );
    } catch (error) {
      throw new LspUnavailableError(
        family,
        `Unable to start ${server.capability.implementation}: ${safeErrorMessage(error)}`,
      );
    }

    const session = new LspSession({
      family,
      socket,
      child,
      mapper: this.#uriMapper,
      shutdownTimeoutMs: this.#shutdownTimeoutMs,
      maxHeaderBytes: this.#maxHeaderBytes,
      maxServerMessageBytes: this.#maxServerMessageBytes,
      maxClientMessageBytes: this.#maxClientMessageBytes,
      maxPendingInputBytes: this.#maxPendingInputBytes,
      maxPendingOutputBytes: this.#maxPendingOutputBytes,
      ...(this.#typeScriptServerEntry
        ? { typeScriptServerEntry: this.#typeScriptServerEntry }
        : {}),
      onClosed: () => {
        if (this.#sessions.get(family) === session) {
          this.#sessions.delete(family);
        }
      },
    });
    this.#sessions.set(family, session);
    session.start();
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    const sessions = [...this.#sessions.values()];
    this.#closePromise = Promise.all(
      sessions.map((session) =>
        session.close(1001, "Constelix is shutting down"),
      ),
    ).then(() => undefined);
    return this.#closePromise;
  }
}

interface LspSessionOptions {
  family: LspServerFamily;
  socket: LspWebSocket;
  child: LspChildProcess;
  mapper: LspUriMapper;
  shutdownTimeoutMs: number;
  maxHeaderBytes: number;
  maxServerMessageBytes: number;
  maxClientMessageBytes: number;
  maxPendingInputBytes: number;
  maxPendingOutputBytes: number;
  typeScriptServerEntry?: string;
  onClosed: () => void;
}

class LspSession {
  readonly #family: LspServerFamily;
  readonly #socket: LspWebSocket;
  readonly #child: LspChildProcess;
  readonly #mapper: LspUriMapper;
  readonly #parser: LspContentLengthParser;
  readonly #shutdownTimeoutMs: number;
  readonly #maxClientMessageBytes: number;
  readonly #maxPendingInputBytes: number;
  readonly #maxPendingOutputBytes: number;
  readonly #typeScriptServerEntry: string | undefined;
  readonly #onClosed: () => void;
  readonly #pendingInput: Buffer[] = [];
  readonly #exitPromise: Promise<void>;
  #resolveExit: (() => void) | undefined;
  #pendingInputBytes = 0;
  #waitingForDrain = false;
  #started = false;
  #exited = false;
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: LspSessionOptions) {
    this.#family = options.family;
    this.#socket = options.socket;
    this.#child = options.child;
    this.#mapper = options.mapper;
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs;
    this.#maxClientMessageBytes = options.maxClientMessageBytes;
    this.#maxPendingInputBytes = options.maxPendingInputBytes;
    this.#maxPendingOutputBytes = options.maxPendingOutputBytes;
    this.#typeScriptServerEntry = options.typeScriptServerEntry;
    this.#onClosed = options.onClosed;
    this.#parser = new LspContentLengthParser(
      options.maxServerMessageBytes,
      options.maxHeaderBytes,
    );
    this.#exitPromise = new Promise((resolveExit) => {
      this.#resolveExit = resolveExit;
    });
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#socket.on("message", this.#handleSocketMessage);
    this.#socket.once("close", () => {
      void this.close(undefined, undefined, false);
    });
    this.#socket.once("error", () => {
      void this.close(undefined, undefined, false);
    });
    this.#child.stdout.on("data", (chunk) => {
      this.#handleServerData(chunk);
    });
    this.#child.stderr.on("data", () => {
      // Language-server stderr can contain local paths or source excerpts.
      // It intentionally remains local and is never forwarded to the browser.
    });
    this.#child.once("exit", () => {
      this.#markExited();
      if (!this.#closing && this.#socket.readyState === 1) {
        this.#socket.close(1011, `${this.#family} language server exited`);
      }
      void this.close(undefined, undefined, false);
    });
    this.#child.once("error", () => {
      if (!this.#closing && this.#socket.readyState === 1) {
        this.#socket.close(1011, `${this.#family} language server failed`);
      }
      void this.close(undefined, undefined, false);
    });
  }

  readonly #handleSocketMessage = (raw: unknown): void => {
    if (this.#closing) return;
    try {
      const encoded = toBuffer(raw);
      if (encoded.byteLength > this.#maxClientMessageBytes) {
        throw new LspProtocolError(
          "The browser LSP message exceeds its size limit.",
        );
      }
      const envelope = parseJsonRpcEnvelope(encoded.toString("utf8"));
      if (
        envelope.method &&
        !ALLOWED_CLIENT_LSP_METHODS.has(envelope.method)
      ) {
        throw new LspProtocolError(
          "The browser requested an unsupported LSP method.",
        );
      }
      const mapped = this.#mapper.mapClientMessage(envelope);
      const hardened = hardenClientEnvelope(
        mapped,
        this.#family,
        this.#typeScriptServerEntry,
        this.#mapper.workspaceRoot,
      );
      const serialized = JSON.stringify(hardened);
      const framed = frameLspMessage(serialized);
      this.#enqueueInput(framed);
    } catch {
      if (this.#socket.readyState === 1) {
        this.#socket.close(1002, "Invalid LSP message");
      }
      void this.close(undefined, undefined, false);
    }
  };

  #handleServerData(chunk: Uint8Array): void {
    if (this.#closing) return;
    try {
      for (const body of this.#parser.push(chunk)) {
        const envelope = parseJsonRpcEnvelope(body.toString("utf8"));
        const mapped = this.#mapper.mapServerMessage(envelope);
        if (mapped === undefined) continue;
        if (this.#socket.readyState === 1) {
          const serialized = JSON.stringify(mapped);
          if (
            (this.#socket.bufferedAmount ?? 0) +
              Buffer.byteLength(serialized, "utf8") >
            this.#maxPendingOutputBytes
          ) {
            throw new LspProtocolError(
              "The pending browser output exceeds its size limit.",
            );
          }
          this.#socket.send(serialized);
        }
      }
    } catch {
      if (this.#socket.readyState === 1) {
        this.#socket.close(1011, "Invalid language-server response");
      }
      void this.close(undefined, undefined, false);
    }
  }

  #enqueueInput(message: Buffer): void {
    this.#pendingInputBytes += message.byteLength;
    if (this.#pendingInputBytes > this.#maxPendingInputBytes) {
      throw new LspProtocolError(
        "The pending language-server input exceeds its size limit.",
      );
    }
    this.#pendingInput.push(message);
    this.#flushInput();
  }

  #flushInput(): void {
    if (this.#waitingForDrain || this.#closing) return;
    while (this.#pendingInput.length > 0) {
      const message = this.#pendingInput.shift();
      if (!message) return;
      this.#pendingInputBytes -= message.byteLength;
      const accepted = this.#child.stdin.write(message);
      if (!accepted) {
        this.#waitingForDrain = true;
        this.#child.stdin.once("drain", () => {
          this.#waitingForDrain = false;
          this.#flushInput();
        });
        return;
      }
    }
  }

  close(
    socketCode?: number,
    socketReason?: string,
    closeSocket = true,
  ): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#socket.off?.("message", this.#handleSocketMessage);
    this.#closePromise = Promise.resolve()
      .then(() => this.#stopProcess())
      .finally(() => {
        this.#onClosed();
      });
    if (closeSocket && this.#socket.readyState === 1) {
      this.#socket.close(socketCode, socketReason);
    }
    this.#pendingInput.length = 0;
    this.#pendingInputBytes = 0;
    return this.#closePromise;
  }

  async #stopProcess(): Promise<void> {
    if (this.#exited || processHasExited(this.#child)) {
      this.#markExited();
      return;
    }
    this.#child.stdin.end();
    this.#child.kill("SIGTERM");
    if (await waitFor(this.#exitPromise, this.#shutdownTimeoutMs)) return;
    if (!this.#exited && !processHasExited(this.#child)) {
      this.#child.kill("SIGKILL");
      await waitFor(this.#exitPromise, this.#shutdownTimeoutMs);
    }
  }

  #markExited(): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#resolveExit?.();
    this.#resolveExit = undefined;
  }
}

function parseContentLength(header: string, maximum: number): number {
  let contentLength: number | undefined;
  for (const line of header.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new LspProtocolError("The LSP header is malformed.");
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name !== "content-length") continue;
    if (contentLength !== undefined || !/^[0-9]+$/u.test(value)) {
      throw new LspProtocolError(
        "The LSP Content-Length header is invalid.",
      );
    }
    contentLength = Number(value);
  }
  if (
    contentLength === undefined ||
    !Number.isSafeInteger(contentLength) ||
    contentLength <= 0
  ) {
    throw new LspProtocolError(
      "The LSP Content-Length header is missing or invalid.",
    );
  }
  if (contentLength > maximum) {
    throw new LspProtocolError(
      "The LSP message exceeds its size limit.",
    );
  }
  return contentLength;
}

function parseJsonRpcEnvelope(source: string): JsonRpcEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new LspProtocolError("The LSP payload is not valid JSON.");
  }
  if (!isRecord(value) || value.jsonrpc !== "2.0") {
    throw new LspProtocolError(
      "The LSP payload is not a JSON-RPC 2.0 message.",
    );
  }
  const hasMethod = Object.hasOwn(value, "method");
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (
    (hasMethod && (hasResult || hasError)) ||
    (!hasMethod && hasResult === hasError)
  ) {
    throw new LspProtocolError("The JSON-RPC envelope is malformed.");
  }
  if (
    hasMethod &&
    (typeof value.method !== "string" || value.method.length === 0)
  ) {
    throw new LspProtocolError("The JSON-RPC method is invalid.");
  }
  if (
    Object.hasOwn(value, "id") &&
    value.id !== null &&
    typeof value.id !== "string" &&
    typeof value.id !== "number"
  ) {
    throw new LspProtocolError("The JSON-RPC id is invalid.");
  }
  if (hasError && !isRecord(value.error)) {
    throw new LspProtocolError("The JSON-RPC error is invalid.");
  }
  return value as JsonRpcEnvelope;
}

function mapJsonRpcEnvelope(
  envelope: JsonRpcEnvelope,
  mapString: (
    value: string,
    property: string | undefined,
  ) => string | typeof EXTERNAL_URI,
  filterExternal = false,
): JsonRpcEnvelope | typeof EXTERNAL_URI {
  const mapped = mapValue(
    envelope,
    undefined,
    mapString,
    filterExternal,
  );
  return mapped as JsonRpcEnvelope | typeof EXTERNAL_URI;
}

function mapValue(
  value: unknown,
  property: string | undefined,
  mapString: (
    value: string,
    property: string | undefined,
  ) => string | typeof EXTERNAL_URI,
  filterExternal: boolean,
): unknown | typeof EXTERNAL_URI {
  if (typeof value === "string") return mapString(value, property);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const item of value) {
      const mapped = mapValue(
        item,
        property,
        mapString,
        filterExternal,
      );
      if (mapped !== EXTERNAL_URI) output.push(mapped);
    }
    return output;
  }
  if (!isRecord(value)) return value;

  const output: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    const mapped = mapValue(item, key, mapString, filterExternal);
    if (mapped === EXTERNAL_URI) {
      if (URI_PROPERTY_NAMES.has(key)) return EXTERNAL_URI;
      if (key === "result") {
        output[key] = null;
        continue;
      }
      if (key === "params" && filterExternal) return EXTERNAL_URI;
      continue;
    }
    output[key] = mapped;
  }
  return output;
}

function decodeConstelixPath(pathname: string): string {
  const rawSegments = pathname.split("/").filter(Boolean);
  const segments = rawSegments.map((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new LspProtocolError("The document URI encoding is invalid.");
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0")
    ) {
      throw new LspProtocolError(
        "The document URI escapes the workspace.",
      );
    }
    return decoded;
  });
  return segments.join("/");
}

function rawConstelixPath(uri: string): string {
  const match =
    /^constelix:\/\/[^/?#]*(\/[^?#]*)?(?:[?#].*)?$/iu.exec(uri);
  if (!match) {
    throw new LspProtocolError("The client sent an invalid document URI.");
  }
  return match[1] ?? "";
}

function canonicalExistingDirectory(path: string): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(resolve(path));
    if (!statSync(canonical).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new LspProtocolError(
      "The LSP workspace root must be an existing directory.",
    );
  }
  return canonical;
}

function assertCanonicalContainment(root: string, candidate: string): void {
  if (!hasCanonicalContainment(root, candidate)) {
    throw new LspProtocolError(
      "The document URI resolves outside the workspace.",
    );
  }
}

function hasCanonicalContainment(
  root: string,
  candidate: string,
): boolean {
  try {
    return isContained(root, realpathSync.native(candidate));
  } catch {
    let parent = dirname(candidate);
    while (isContained(root, parent)) {
      try {
        return isContained(root, realpathSync.native(parent));
      } catch {
        const next = dirname(parent);
        if (next === parent) break;
        parent = next;
      }
    }
    return false;
  }
}

function assertContained(root: string, candidate: string): void {
  if (!isContained(root, candidate)) {
    throw new LspProtocolError(
      "The document URI escapes the workspace.",
    );
  }
}

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (!isAbsolute(fromRoot) &&
      fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`))
  );
}

function toPosixPath(path: string): string {
  return sep === "/" ? path : path.replaceAll(sep, "/");
}

function normalizeFamily(language: LspLanguage): LspServerFamily {
  return language === "python" ? "python" : "typescript";
}

function resolveServer(
  family: LspServerFamily,
  implementation: LspServerCapability["implementation"],
  resolver: NonNullable<LspManagerOptions["resolveServerEntry"]>,
): ResolvedLspServer {
  let entryPath: string | undefined;
  try {
    const candidate = resolver(family);
    if (
      candidate &&
      existsSync(candidate) &&
      statSync(candidate).isFile()
    ) {
      entryPath = resolve(candidate);
    }
  } catch {
    entryPath = undefined;
  }
  return entryPath
    ? {
        entryPath,
        capability: { available: true, implementation },
      }
    : {
        capability: {
          available: false,
          implementation,
          reason: `${implementation} is not installed in the Constelix runtime.`,
        },
      };
}

function defaultResolveServerEntry(
  family: LspServerFamily,
): string | undefined {
  const require = createRequire(import.meta.url);
  try {
    if (family === "typescript") {
      const manifest = require.resolve(
        "typescript-language-server/package.json",
      );
      return resolve(dirname(manifest), "lib", "cli.mjs");
    }
    const manifest = require.resolve("pyright/package.json");
    return resolve(dirname(manifest), "langserver.index.js");
  } catch {
    return undefined;
  }
}

function defaultResolveTypeScriptServerEntry(): string | undefined {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve("typescript/lib/tsserver.js");
  } catch {
    return undefined;
  }
}

function resolveTrustedFile(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  try {
    const canonical = realpathSync.native(candidate);
    return statSync(canonical).isFile() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function hardenClientEnvelope(
  envelope: JsonRpcEnvelope,
  family: LspServerFamily,
  typeScriptServerEntry: string | undefined,
  workspaceRoot: string,
): JsonRpcEnvelope {
  if (envelope.method !== "initialize") {
    return envelope;
  }
  if (family === "typescript" && !typeScriptServerEntry) {
    throw new LspProtocolError(
      "The trusted TypeScript server is unavailable.",
    );
  }
  const params = isRecord(envelope.params)
    ? envelope.params
    : Object.create(null) as Record<string, unknown>;
  return {
    ...envelope,
    params: {
      ...params,
      rootPath: null,
      rootUri: pathToFileURL(workspaceRoot).href,
      workspaceFolders: [{
        name: "workspace",
        uri: pathToFileURL(workspaceRoot).href,
      }],
      initializationOptions:
        family === "typescript"
          ? {
              disableAutomaticTypingAcquisition: true,
              plugins: [],
              tsserver: {
                fallbackPath: typeScriptServerEntry,
                path: typeScriptServerEntry,
              },
            }
          : {},
    },
  };
}

function defaultSpawnProcess(
  command: string,
  args: readonly string[],
  options: LspSpawnOptions,
): LspChildProcess {
  return spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
}

export function createLspEnvironment(
  workspaceRoot: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = [
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOGNAME",
    "PATH",
    "SHELL",
    "TMPDIR",
    "USER",
  ] as const;
  const environment: NodeJS.ProcessEnv = {
    CONSTELIX_WORKSPACE: workspaceRoot,
    NO_COLOR: "1",
  };
  for (const name of allowed) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function cloneCapability(
  capability: LspServerCapability,
): LspServerCapability {
  return capability.reason === undefined
    ? {
        available: capability.available,
        implementation: capability.implementation,
      }
    : {
        available: capability.available,
        implementation: capability.implementation,
        reason: capability.reason,
      };
}

function toBuffer(raw: unknown): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (typeof raw === "string") return Buffer.from(raw, "utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  if (Array.isArray(raw) && raw.every(Buffer.isBuffer)) {
    return Buffer.concat(raw);
  }
  if (
    isRecord(raw) &&
    typeof raw.toString === "function"
  ) {
    return Buffer.from(String(raw), "utf8");
  }
  throw new LspProtocolError("The WebSocket payload type is invalid.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function processHasExited(processHandle: LspChildProcess): boolean {
  return (
    processHandle.exitCode !== null ||
    processHandle.signalCode !== null
  );
}

async function waitFor(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(false), timeoutMs);
    timer.unref();
  });
  const completed = promise.then(() => true);
  const result = await Promise.race([completed, timedOut]);
  if (timer) clearTimeout(timer);
  return result;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
