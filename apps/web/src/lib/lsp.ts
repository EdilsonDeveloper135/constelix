import type * as Monaco from "monaco-editor";

import { apiClient } from "./api";

type LspLanguage = "typescript" | "javascript" | "python";
type JsonRecord = Record<string, unknown>;

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

interface LspLocation {
  uri: string;
  range: LspRange;
}

interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

interface LspConnectionCallbacks {
  diagnostics(uri: string, diagnostics: LspDiagnostic[]): void;
  status(status: LspDocumentStatus): void;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: number;
  cancellationDisposable?: Monaco.IDisposable;
}

export type LspDocumentStatus =
  | "connecting"
  | "ready"
  | "unavailable"
  | "error";

export interface MonacoLspDocument {
  dispose(): void;
}

export function constelixDocumentUri(
  workspaceId: string,
  relativePath: string,
): string {
  if (
    !/^[A-Za-z0-9._-]+$/u.test(workspaceId) ||
    !relativePath ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.includes("\0")
  ) {
    throw new TypeError("Invalid Constelix document identity.");
  }
  const segments = relativePath.split("/");
  if (
    segments.some(
      (segment) =>
        !segment || segment === "." || segment === "..",
    )
  ) {
    throw new TypeError("Invalid Constelix document path.");
  }
  return `constelix://${workspaceId}/${segments
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

const connections = new Map<LspLanguage, JsonRpcLspConnection>();
const providerDisposables: Monaco.IDisposable[] = [];
let configuredMonaco: typeof Monaco | undefined;
let openResource:
  | ((relativePath: string, line: number, column: number) => void)
  | undefined;

export function configureMonacoLsp(
  monaco: typeof Monaco,
  opener: (relativePath: string, line: number, column: number) => void,
): void {
  openResource = opener;
  if (configuredMonaco === monaco) return;
  for (const disposable of providerDisposables.splice(0)) {
    disposable.dispose();
  }
  configuredMonaco = monaco;
  for (const language of ["typescript", "javascript", "python"] as const) {
    providerDisposables.push(
      monaco.languages.registerCompletionItemProvider(
        language,
        completionProvider(monaco, language),
      ),
      monaco.languages.registerHoverProvider(
        language,
        hoverProvider(monaco, language),
      ),
      monaco.languages.registerDefinitionProvider(
        language,
        definitionProvider(monaco, language),
      ),
      monaco.languages.registerReferenceProvider(
        language,
        referenceProvider(monaco, language),
      ),
    );
  }
  providerDisposables.push(
    monaco.editor.registerEditorOpener({
      openCodeEditor(_source, resource, selection) {
        const relativePath = relativePathFromResource(resource);
        if (!relativePath || !openResource) return false;
        const start = editorSelectionStart(selection);
        openResource(
          relativePath,
          start.line,
          start.column,
        );
        return true;
      },
    }),
  );
}

export function attachMonacoLspDocument(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  language: string,
  callbacks: LspConnectionCallbacks,
): MonacoLspDocument {
  const lspLanguage = normalizeLanguage(language);
  if (!lspLanguage || model.uri.scheme !== "constelix") {
    callbacks.status("unavailable");
    return { dispose() {} };
  }
  const connection = connectionFor(lspLanguage);
  let version = 1;
  let changeTimer: number | undefined;
  let disposed = false;
  const uri = model.uri.toString();
  const unsubscribeDiagnostics = connection.subscribeDiagnostics(
    (diagnosticUri, diagnostics) => {
      if (diagnosticUri !== uri || disposed) return;
      monaco.editor.setModelMarkers(
        model,
        "constelix-lsp",
        diagnostics.slice(0, 500).map((diagnostic) =>
          markerFromDiagnostic(monaco, diagnostic)
        ),
      );
      callbacks.diagnostics(uri, diagnostics);
    },
  );
  const unsubscribeStatus = connection.subscribeStatus(callbacks.status);
  const changeDisposable = model.onDidChangeContent(() => {
    if (changeTimer !== undefined) window.clearTimeout(changeTimer);
    changeTimer = window.setTimeout(() => {
      changeTimer = undefined;
      if (disposed) return;
      version += 1;
      void connection.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: model.getValue() }],
      });
    }, 75);
  });

  void connection.ready()
    .then(() => {
      if (disposed) return;
      return connection.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: lspLanguage,
          version,
          text: model.getValue(),
        },
      });
    })
    .catch(() => callbacks.status("unavailable"));

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (changeTimer !== undefined) window.clearTimeout(changeTimer);
      changeDisposable.dispose();
      unsubscribeDiagnostics();
      unsubscribeStatus();
      monaco.editor.setModelMarkers(model, "constelix-lsp", []);
      void connection.notify("textDocument/didClose", {
        textDocument: { uri },
      });
    },
  };
}

export function closeMonacoLspConnections(): void {
  for (const connection of connections.values()) connection.close();
  connections.clear();
}

function connectionFor(language: LspLanguage): JsonRpcLspConnection {
  const family = language === "javascript" ? "typescript" : language;
  const existing = connections.get(family);
  if (existing) return existing;
  const connection = new JsonRpcLspConnection(family);
  connections.set(family, connection);
  return connection;
}

export class JsonRpcLspConnection {
  readonly #pending = new Map<number, PendingRequest>();
  readonly #diagnosticListeners = new Set<
    (uri: string, diagnostics: LspDiagnostic[]) => void
  >();
  readonly #statusListeners = new Set<(status: LspDocumentStatus) => void>();
  #socket: WebSocket | null = null;
  #readyPromise: Promise<void> | null = null;
  #requestId = 0;
  #status: LspDocumentStatus = "connecting";

  constructor(private readonly language: LspLanguage) {}

  ready(): Promise<void> {
    if (this.#readyPromise) return this.#readyPromise;
    this.#readyPromise = new Promise<void>((resolve, reject) => {
      this.publishStatus("connecting");
      const socket = new WebSocket(apiClient.lspSocketUrl(this.language));
      this.#socket = socket;
      let startupSettled = false;
      const fail = (error: Error) => {
        if (startupSettled) return;
        startupSettled = true;
        this.publishStatus("unavailable");
        this.#readyPromise = null;
        if (
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING
        ) {
          socket.close(1011, "LSP initialization failed");
        }
        reject(error);
      };
      socket.addEventListener("open", () => {
        void this.request("initialize", {
          processId: null,
          clientInfo: { name: "Constelix", version: "0.0.7" },
          locale: navigator.language,
          rootUri: "constelix://workspace/",
          workspaceFolders: [
            { uri: "constelix://workspace/", name: "workspace" },
          ],
          capabilities: {
            workspace: { configuration: true },
            textDocument: {
              synchronization: { didSave: false },
              completion: {
                completionItem: {
                  snippetSupport: true,
                  documentationFormat: ["markdown", "plaintext"],
                },
              },
              hover: { contentFormat: ["markdown", "plaintext"] },
              definition: { linkSupport: true },
              references: {},
              publishDiagnostics: {
                relatedInformation: true,
                versionSupport: true,
              },
            },
          },
        })
          .then(() => this.notify("initialized", {}))
          .then(() => {
            startupSettled = true;
            this.publishStatus("ready");
            resolve();
          })
          .catch(fail);
      });
      socket.addEventListener("message", (event) => {
        this.consumeMessage(String(event.data));
      });
      socket.addEventListener("error", () => {
        if (this.#status !== "ready") {
          fail(new Error("No se pudo iniciar el servidor de lenguaje."));
        } else {
          this.publishStatus("error");
        }
      });
      socket.addEventListener("close", () => {
        if (this.#socket === socket) this.#socket = null;
        this.rejectPending(new Error("El servidor de lenguaje se desconectó."));
        this.publishStatus("unavailable");
        this.#readyPromise = null;
      });
    });
    return this.#readyPromise;
  }

  async request(
    method: string,
    params: unknown,
    cancellation?: Monaco.CancellationToken,
  ): Promise<unknown> {
    if (method !== "initialize") await this.ready();
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("El servidor de lenguaje no está conectado.");
    }
    const id = ++this.#requestId;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        const pending = this.#pending.get(id);
        pending?.cancellationDisposable?.dispose();
        this.#pending.delete(id);
        reject(new Error(`La solicitud LSP ${method} excedió el tiempo límite.`));
      }, 8_000);
      const pending: PendingRequest = { resolve, reject, timer };
      this.#pending.set(id, pending);
      const cancellationDisposable =
        cancellation?.onCancellationRequested(() => {
          pending.cancellationDisposable?.dispose();
          void this.notify("$/cancelRequest", { id });
          const active = this.#pending.get(id);
          if (!active) return;
          window.clearTimeout(active.timer);
          this.#pending.delete(id);
          active.reject(new DOMException("Solicitud cancelada.", "AbortError"));
        });
      if (cancellationDisposable) {
        pending.cancellationDisposable = cancellationDisposable;
      }
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (method !== "initialized" && method !== "textDocument/didClose") {
      await this.ready();
    }
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  subscribeDiagnostics(
    listener: (uri: string, diagnostics: LspDiagnostic[]) => void,
  ): () => void {
    this.#diagnosticListeners.add(listener);
    return () => this.#diagnosticListeners.delete(listener);
  }

  subscribeStatus(
    listener: (status: LspDocumentStatus) => void,
  ): () => void {
    this.#statusListeners.add(listener);
    listener(this.#status);
    return () => this.#statusListeners.delete(listener);
  }

  close(): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#readyPromise = null;
    socket?.close(1000, "Workspace changed");
    this.rejectPending(new Error("La sesión LSP terminó."));
    this.publishStatus("unavailable");
  }

  private consumeMessage(serialized: string): void {
    let message: JsonRecord;
    try {
      const parsed = JSON.parse(serialized) as unknown;
      if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") return;
      message = parsed;
    } catch {
      return;
    }
    if (typeof message.id === "number" && !message.method) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      window.clearTimeout(pending.timer);
      pending.cancellationDisposable?.dispose();
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(lspErrorMessage(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    if (message.method === "textDocument/publishDiagnostics") {
      const params = isRecord(message.params) ? message.params : {};
      if (typeof params.uri !== "string" || !Array.isArray(params.diagnostics)) {
        return;
      }
      const diagnostics = params.diagnostics.filter(isLspDiagnostic);
      this.#diagnosticListeners.forEach((listener) =>
        listener(params.uri as string, diagnostics)
      );
      return;
    }
    if (message.id !== undefined) {
      this.respondToServerRequest(message);
    }
  }

  private respondToServerRequest(message: JsonRecord): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    let result: unknown = null;
    if (message.method === "workspace/configuration") {
      const items = isRecord(message.params) && Array.isArray(message.params.items)
        ? message.params.items
        : [];
      result = items.map(() => ({ tabSize: 2, insertSpaces: true }));
    } else if (message.method === "workspace/applyEdit") {
      result = { applied: false, failureReason: "Constelix aplica ediciones solo mediante su API de archivos." };
    } else if (message.method === "window/showDocument") {
      result = { success: false };
    }
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  }

  private publishStatus(status: LspDocumentStatus): void {
    this.#status = status;
    this.#statusListeners.forEach((listener) => listener(status));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      window.clearTimeout(pending.timer);
      pending.cancellationDisposable?.dispose();
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function completionProvider(
  monaco: typeof Monaco,
  language: LspLanguage,
): Monaco.languages.CompletionItemProvider {
  return {
    triggerCharacters: [".", '"', "'", "/", "@", "<"],
    async provideCompletionItems(model, position, context, token) {
      if (model.uri.scheme !== "constelix") return { suggestions: [] };
      const result = await connectionFor(language).request(
        "textDocument/completion",
        {
          textDocument: { uri: model.uri.toString() },
          position: toLspPosition(position),
          context: {
            triggerKind: context.triggerKind,
            ...(context.triggerCharacter
              ? { triggerCharacter: context.triggerCharacter }
              : {}),
          },
        },
        token,
      ).catch(() => null);
      const items = Array.isArray(result)
        ? result
        : isRecord(result) && Array.isArray(result.items)
          ? result.items
          : [];
      return {
        suggestions: items.slice(0, 300).flatMap((item) =>
          isRecord(item)
            ? [completionItem(monaco, model, position, item)]
            : []
        ),
      };
    },
  };
}

function hoverProvider(
  _monaco: typeof Monaco,
  language: LspLanguage,
): Monaco.languages.HoverProvider {
  return {
    async provideHover(model, position, token) {
      if (model.uri.scheme !== "constelix") return null;
      const result = await connectionFor(language).request(
        "textDocument/hover",
        {
          textDocument: { uri: model.uri.toString() },
          position: toLspPosition(position),
        },
        token,
      ).catch(() => null);
      if (!isRecord(result)) return null;
      const value = hoverText(result.contents);
      if (!value) return null;
      return {
        contents: [{ value, isTrusted: false, supportHtml: false }],
        ...(isLspRange(result.range) ? { range: toMonacoRange(result.range) } : {}),
      };
    },
  };
}

function definitionProvider(
  _monaco: typeof Monaco,
  language: LspLanguage,
): Monaco.languages.DefinitionProvider {
  return {
    async provideDefinition(model, position, token) {
      if (model.uri.scheme !== "constelix") return [];
      const result = await connectionFor(language).request(
        "textDocument/definition",
        {
          textDocument: { uri: model.uri.toString() },
          position: toLspPosition(position),
        },
        token,
      ).catch(() => null);
      return locationsFromResult(result).slice(0, 200).map(toMonacoLocation);
    },
  };
}

function referenceProvider(
  _monaco: typeof Monaco,
  language: LspLanguage,
): Monaco.languages.ReferenceProvider {
  return {
    async provideReferences(model, position, context, token) {
      if (model.uri.scheme !== "constelix") return [];
      const result = await connectionFor(language).request(
        "textDocument/references",
        {
          textDocument: { uri: model.uri.toString() },
          position: toLspPosition(position),
          context: { includeDeclaration: context.includeDeclaration },
        },
        token,
      ).catch(() => null);
      return locationsFromResult(result).slice(0, 200).map(toMonacoLocation);
    },
  };
}

function completionItem(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  item: JsonRecord,
): Monaco.languages.CompletionItem {
  const textEdit = isRecord(item.textEdit) ? item.textEdit : undefined;
  const insertText =
    textEdit && typeof textEdit.newText === "string"
      ? textEdit.newText
      : typeof item.insertText === "string"
        ? item.insertText
        : typeof item.label === "string"
          ? item.label
          : "";
  const word = model.getWordUntilPosition(position);
  const textEditRange =
    textEdit && isLspRange(textEdit.range)
      ? textEdit.range
      : textEdit && isLspRange(textEdit.insert)
        ? textEdit.insert
        : undefined;
  const additionalTextEdits = Array.isArray(item.additionalTextEdits)
    ? item.additionalTextEdits
        .slice(0, 50)
        .flatMap((edit) =>
          isRecord(edit) &&
          typeof edit.newText === "string" &&
          isLspRange(edit.range)
            ? [{
                range: toMonacoRange(edit.range),
                text: edit.newText,
              }]
            : []
        )
    : [];
  return {
    label:
      typeof item.label === "string"
        ? item.label
        : typeof item.label === "object" && item.label !== null &&
            typeof (item.label as JsonRecord).label === "string"
          ? (item.label as JsonRecord).label as string
          : insertText,
    kind: Math.max(
      0,
      Math.min(
        monaco.languages.CompletionItemKind.TypeParameter,
        (typeof item.kind === "number" ? item.kind : 1) - 1,
      ),
    ) as Monaco.languages.CompletionItemKind,
    insertText,
    range:
      textEditRange
        ? toMonacoRange(textEditRange)
        : {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          },
    ...(typeof item.detail === "string" ? { detail: item.detail } : {}),
    ...(item.documentation === undefined
      ? {}
      : {
          documentation: {
            value: hoverText(item.documentation),
            isTrusted: false,
            supportHtml: false,
          },
        }),
    ...(item.insertTextFormat === 2
      ? {
          insertTextRules:
            monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        }
      : {}),
    ...(additionalTextEdits.length > 0 ? { additionalTextEdits } : {}),
    ...(typeof item.sortText === "string"
      ? { sortText: item.sortText }
      : {}),
    ...(typeof item.filterText === "string"
      ? { filterText: item.filterText }
      : {}),
  };
}

function markerFromDiagnostic(
  monaco: typeof Monaco,
  diagnostic: LspDiagnostic,
): Monaco.editor.IMarkerData {
  const severity =
    diagnostic.severity === 1
      ? monaco.MarkerSeverity.Error
      : diagnostic.severity === 2
        ? monaco.MarkerSeverity.Warning
        : diagnostic.severity === 3
          ? monaco.MarkerSeverity.Info
          : monaco.MarkerSeverity.Hint;
  return {
    ...toMonacoRange(diagnostic.range),
    severity,
    message: diagnostic.message,
    ...(diagnostic.source ? { source: diagnostic.source } : {}),
    ...(diagnostic.code === undefined
      ? {}
      : { code: String(diagnostic.code) }),
  };
}

function toLspPosition(position: Monaco.Position): LspPosition {
  return {
    line: position.lineNumber - 1,
    character: position.column - 1,
  };
}

function toMonacoRange(range: LspRange): Monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

function toMonacoLocation(location: LspLocation): Monaco.languages.Location {
  return {
    uri: configuredMonaco?.Uri.parse(location.uri) ??
      (location.uri as unknown as Monaco.Uri),
    range: toMonacoRange(location.range),
  };
}

function locationsFromResult(value: unknown): LspLocation[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.flatMap((item) => {
    if (!isRecord(item)) return [];
    const uri =
      typeof item.uri === "string"
        ? item.uri
        : typeof item.targetUri === "string"
          ? item.targetUri
          : undefined;
    const range = isLspRange(item.range)
      ? item.range
      : isLspRange(item.targetSelectionRange)
        ? item.targetSelectionRange
        : undefined;
    return uri?.startsWith("constelix://") && range ? [{ uri, range }] : [];
  });
}

function relativePathFromResource(resource: Monaco.Uri): string | undefined {
  if (resource.scheme !== "constelix") return undefined;
  const path = resource.path.replace(/^\/+/, "");
  if (
    !path ||
    path.includes("\0") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return path;
}

function editorSelectionStart(
  selection: Monaco.IRange | Monaco.IPosition | undefined,
): { line: number; column: number } {
  if (!selection) return { line: 1, column: 1 };
  if ("startLineNumber" in selection) {
    return {
      line: selection.startLineNumber,
      column: selection.startColumn,
    };
  }
  return {
    line: selection.lineNumber,
    column: selection.column,
  };
}

function hoverText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(hoverText).filter(Boolean).join("\n\n");
  }
  if (!isRecord(value)) return "";
  if (typeof value.language === "string" && typeof value.value === "string") {
    return `\`\`\`${value.language}\n${value.value}\n\`\`\``;
  }
  if (typeof value.value === "string") return value.value;
  return "";
}

function normalizeLanguage(language: string): LspLanguage | undefined {
  if (language === "typescript" || language === "tsx") return "typescript";
  if (language === "javascript" || language === "jsx") return "javascript";
  if (language === "python") return "python";
  return undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLspRange(value: unknown): value is LspRange {
  if (!isRecord(value) || !isRecord(value.start) || !isRecord(value.end)) {
    return false;
  }
  return (
    typeof value.start.line === "number" &&
    typeof value.start.character === "number" &&
    typeof value.end.line === "number" &&
    typeof value.end.character === "number"
  );
}

function isLspDiagnostic(value: unknown): value is LspDiagnostic {
  return (
    isRecord(value) &&
    isLspRange(value.range) &&
    typeof value.message === "string"
  );
}

function lspErrorMessage(value: unknown): string {
  if (isRecord(value) && typeof value.message === "string") {
    return value.message;
  }
  return "El servidor de lenguaje rechazó la solicitud.";
}
