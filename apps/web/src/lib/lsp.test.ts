import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  lspSocketUrl: vi.fn(
    (language: string) =>
      `ws://127.0.0.1/api/v1/lsp?language=${language}`,
  ),
}));

vi.mock("./api", () => ({ apiClient: apiMock }));

import {
  JsonRpcLspConnection,
  closeMonacoLspConnections,
  constelixDocumentUri,
  renameProvider,
  workspaceEditChanges,
} from "./lsp";

class FakeUri {
  readonly scheme: string;
  constructor(private readonly value: string) {
    this.scheme = value.slice(0, value.indexOf(":"));
  }
  toString(): string {
    return this.value;
  }
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  receive(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  emit(type: string, event: unknown): void {
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  apiMock.lspSocketUrl.mockClear();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("window", globalThis);
});

describe("Constelix Monaco LSP client", () => {
  it("encodes document identities segment by segment", () => {
    expect(
      constelixDocumentUri(
        "0123456789abcdef01234567",
        "src/área/a #1%?.ts",
      ),
    ).toBe(
      "constelix://0123456789abcdef01234567/src/%C3%A1rea/a%20%231%25%3F.ts",
    );
    expect(() =>
      constelixDocumentUri("workspace", "../outside.ts")
    ).toThrow("Invalid Constelix document path");
    expect(() =>
      constelixDocumentUri("workspace/other", "src/main.ts")
    ).toThrow("Invalid Constelix document identity");
  });

  it("initializes JSON-RPC, resolves requests, and denies server edits", async () => {
    const connection = new JsonRpcLspConnection("typescript");
    const statuses: string[] = [];
    connection.subscribeStatus((status) => statuses.push(status));
    const ready = connection.ready();
    const socket = FakeWebSocket.instances.at(0);
    expect(socket?.url).toContain("language=typescript");
    socket?.open();

    const initialize = sentMessage(socket, 0);
    expect(initialize).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        rootUri: "constelix://workspace/",
      },
    });
    socket?.receive({ jsonrpc: "2.0", id: 1, result: {} });
    await ready;
    expect(sentMessage(socket, 1)).toMatchObject({
      method: "initialized",
    });
    expect(statuses.at(-1)).toBe("ready");

    const hover = connection.request("textDocument/hover", {
      textDocument: {
        uri: "constelix://0123456789abcdef01234567/src/main.ts",
      },
      position: { line: 0, character: 1 },
    });
    await Promise.resolve();
    expect(sentMessage(socket, 2)).toMatchObject({
      id: 2,
      method: "textDocument/hover",
    });
    socket?.receive({
      jsonrpc: "2.0",
      id: 2,
      result: { contents: "const value: string" },
    });
    await expect(hover).resolves.toEqual({
      contents: "const value: string",
    });

    socket?.receive({
      jsonrpc: "2.0",
      id: 71,
      method: "workspace/applyEdit",
      params: { edit: {} },
    });
    expect(sentMessage(socket, 3)).toEqual({
      jsonrpc: "2.0",
      id: 71,
      result: {
        applied: false,
        failureReason:
          "Constelix aplica ediciones solo mediante su API de archivos.",
      },
    });
    connection.close();
    expect(statuses.at(-1)).toBe("unavailable");
  });

  it("publishes only validated diagnostics", async () => {
    const connection = new JsonRpcLspConnection("python");
    const diagnostics = vi.fn();
    connection.subscribeDiagnostics(diagnostics);
    const ready = connection.ready();
    const socket = FakeWebSocket.instances.at(0);
    socket?.open();
    socket?.receive({ jsonrpc: "2.0", id: 1, result: {} });
    await ready;

    socket?.receive({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "constelix://0123456789abcdef01234567/main.py",
        diagnostics: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 4 },
            },
            severity: 1,
            message: "Unknown name",
          },
          { range: {}, message: 42 },
        ],
      },
    });

    expect(diagnostics).toHaveBeenCalledWith(
      "constelix://0123456789abcdef01234567/main.py",
      [
        expect.objectContaining({
          severity: 1,
          message: "Unknown name",
        }),
      ],
    );
    connection.close();
  });

  it("applies rename edits only to files already open as a Monaco model, and reports the rest as skipped", async () => {
    closeMonacoLspConnections();
    const openModels = new Map<string, { getVersionId: () => number; uri: FakeUri }>([
      [
        "constelix://0123456789abcdef01234567/open.ts",
        { getVersionId: () => 3, uri: new FakeUri("constelix://0123456789abcdef01234567/open.ts") },
      ],
    ]);
    const fakeMonaco = {
      editor: {
        getModel: (uri: FakeUri) => openModels.get(uri.toString()),
      },
      Uri: { parse: (value: string) => new FakeUri(value) },
    } as unknown as typeof import("monaco-editor");
    const model = {
      uri: new FakeUri("constelix://0123456789abcdef01234567/open.ts"),
    } as unknown as import("monaco-editor").editor.ITextModel;
    const position = { lineNumber: 1, column: 5 } as import("monaco-editor").Position;
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    } as unknown as import("monaco-editor").CancellationToken;

    const provider = renameProvider(fakeMonaco, "typescript");
    const editsPromise = provider.provideRenameEdits(
      model,
      position,
      "renamedSymbol",
      token,
    );

    const socket = FakeWebSocket.instances.at(0);
    socket?.open();
    socket?.receive({ jsonrpc: "2.0", id: 1, result: {} });
    // The rename request is gated behind the initialize/initialized
    // handshake settling `ready()`, which resolves through a couple of
    // chained .then()s inside JsonRpcLspConnection — flush a macrotask
    // rather than guess an exact microtask count.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const renameRequest = sentMessage(socket, 2);
    expect(renameRequest).toMatchObject({ method: "textDocument/rename" });

    socket?.receive({
      jsonrpc: "2.0",
      id: (renameRequest as { id: number }).id,
      result: {
        changes: {
          "constelix://0123456789abcdef01234567/open.ts": [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 3 },
              },
              newText: "renamedSymbol",
            },
          ],
          "constelix://0123456789abcdef01234567/closed.ts": [
            {
              range: {
                start: { line: 2, character: 0 },
                end: { line: 2, character: 3 },
              },
              newText: "renamedSymbol",
            },
          ],
        },
      },
    });

    const edits = await editsPromise;
    if (!edits) throw new Error("Expected a WorkspaceEdit result.");
    expect(edits.edits).toEqual([
      {
        resource: openModels.get(
          "constelix://0123456789abcdef01234567/open.ts",
        )!.uri,
        textEdit: {
          range: {
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 4,
          },
          text: "renamedSymbol",
        },
        versionId: 3,
      },
    ]);
    expect(edits.rejectReason).toContain("1 archivo");
  });
});

describe("workspaceEditChanges", () => {
  it("flattens a legacy `changes` map into [uri, edits] pairs", () => {
    const edits = [{ range: {}, newText: "renamed" }];
    expect(
      workspaceEditChanges({
        changes: {
          "constelix://workspace/a.ts": edits,
          "constelix://workspace/b.ts": edits,
        },
      }),
    ).toEqual([
      ["constelix://workspace/a.ts", edits],
      ["constelix://workspace/b.ts", edits],
    ]);
  });

  it("flattens the modern `documentChanges` array into [uri, edits] pairs", () => {
    const edits = [{ range: {}, newText: "renamed" }];
    expect(
      workspaceEditChanges({
        documentChanges: [
          { textDocument: { uri: "constelix://workspace/a.ts" }, edits },
          // Malformed entries (missing textDocument/edits) are dropped
          // rather than thrown on, matching every other LSP result parser
          // in this file.
          { textDocument: { uri: "constelix://workspace/b.ts" } },
        ],
      }),
    ).toEqual([["constelix://workspace/a.ts", edits]]);
  });

  it("returns undefined for a result with neither shape", () => {
    expect(workspaceEditChanges({})).toBeUndefined();
    expect(workspaceEditChanges(null)).toBeUndefined();
    expect(workspaceEditChanges("not an object")).toBeUndefined();
  });
});

function sentMessage(
  socket: FakeWebSocket | undefined,
  index: number,
): Record<string, unknown> {
  const serialized = socket?.sent.at(index);
  if (!serialized) throw new Error(`Missing WebSocket message ${index}.`);
  return JSON.parse(serialized) as Record<string, unknown>;
}
