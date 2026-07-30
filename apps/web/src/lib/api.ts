import {
  ActTaskSchema,
  EvidencePathSchema,
  FileReadResponseSchema,
  FileWriteResponseSchema,
  GraphSnapshotSchema,
  LlmPublicConfigurationSchema,
  LocalAskResultSchema,
  LspAvailabilitySchema,
  PanelStateSchema,
  ServerEventSchema,
  TerminalSessionSchema,
  TerminalOutputSnapshotSchema,
  WorkspaceBrowseResponseSchema,
  WorkspaceListResponseSchema,
  WorkspaceOpenResponseSchema,
  WorkspaceSessionSchema,
  WorkspaceSummarySchema,
  type ActApproveRequest,
  type ActTask as ContractActTask,
  type ActTaskRequest,
  type AskTurnRequest,
  type FileReadRequest,
  type FileWriteRequest,
  type GraphSnapshot,
  type LlmConfigurationUpdate,
  type LlmPublicConfiguration,
  type PanelState,
  type TerminalCreateRequest,
  type WorkspaceBrowseResponse,
  type WorkspaceListResponse,
  type WorkspaceOpenRequest,
  type WorkspaceOpenResponse,
} from "@constelix/contracts";

import { PROTOCOL_VERSION, type AgentEvent, type BootstrapPayload } from "../types";
import { readCapabilityToken } from "./auth";

type EventListener = (event: AgentEvent) => void;
type SocketConnectionState = "connecting" | "connected" | "disconnected";
type ConnectionListener = (state: SocketConnectionState) => void;
type ReconciliationListener = () => void;
const MAX_KEEPALIVE_BODY_BYTES = 60 * 1024;
type HydratedWorkspaceOpenResponse = Omit<
  WorkspaceOpenResponse,
  "bootstrap"
> & {
  bootstrap: BootstrapPayload;
};

export class AgentRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly recoverable = true,
    readonly severity: "info" | "warning" | "error" = "error",
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AgentRequestError";
  }
}

interface RequestOptions {
  allowWorkspaceTransition?: boolean;
  omitWorkspaceSession?: boolean;
}

export class ConstelixApiClient {
  private readonly token: string | null;
  private workspaceSessionId: string | null = null;
  private pendingWorkspaceSessionId: string | null = null;
  private workspaceEpoch = 0;
  private socket: WebSocket | null = null;
  private listeners = new Set<EventListener>();
  private connectionListeners = new Set<ConnectionListener>();
  private reconciliationListeners = new Set<ReconciliationListener>();
  private missedPendingSessionEvents = false;
  private reconnectTimer: number | null = null;
  private shouldReconnect = true;

  constructor(token: string | null = readCapabilityToken()) {
    this.token = token;
  }

  get hasToken(): boolean {
    return Boolean(this.token);
  }

  get sessionId(): string | null {
    return this.workspaceSessionId;
  }

  get workspaceTransitioning(): boolean {
    return this.pendingWorkspaceSessionId !== null;
  }

  lspSocketUrl(language: "typescript" | "javascript" | "python"): string {
    if (!this.token) throw new Error("El agente local no proporcionó una capacidad LSP.");
    if (this.pendingWorkspaceSessionId || !this.workspaceSessionId) {
      throw new Error(
        "El workspace todavía no terminó de reconciliarse.",
      );
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL(
      `${protocol}//${window.location.host}/api/v1/lsp`,
    );
    url.searchParams.set("token", this.token);
    url.searchParams.set("language", language);
    if (this.workspaceSessionId) {
      url.searchParams.set("session", this.workspaceSessionId);
    }
    return url.toString();
  }

  async request<T>(
    path: string,
    init: RequestInit = {},
    options: RequestOptions = {},
  ): Promise<T> {
    if (
      this.pendingWorkspaceSessionId &&
      options.allowWorkspaceTransition !== true
    ) {
      throw new AgentRequestError(
        "El workspace está cambiando; espera a que termine la reconciliación.",
        409,
        "WORKSPACE_TRANSITION_PENDING",
        true,
        "info",
      );
    }
    const requestEpoch = this.workspaceEpoch;
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined && init.body !== null) {
      headers.set("Content-Type", "application/json");
    }
    headers.set("X-Constelix-Protocol", String(PROTOCOL_VERSION));
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    if (
      this.workspaceSessionId &&
      options.omitWorkspaceSession !== true
    ) {
      headers.set("X-Constelix-Workspace-Session", this.workspaceSessionId);
    }

    const response = await fetch(`/api/v1${path}`, { ...init, headers });
    this.assertCurrentWorkspaceEpoch(requestEpoch);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      this.assertCurrentWorkspaceEpoch(requestEpoch);
      const parsed = parseAgentErrorDetail(detail);
      throw new AgentRequestError(
        parsed.message || `El agente respondió ${response.status}`,
        response.status,
        parsed.code,
        parsed.recoverable,
        parsed.severity,
        parsed.details,
      );
    }
    if (response.status === 204) return undefined as T;
    const payload = (await response.json()) as T;
    this.assertCurrentWorkspaceEpoch(requestEpoch);
    return payload;
  }

  async bootstrap(signal?: AbortSignal): Promise<BootstrapPayload> {
    let response: unknown;
    try {
      response = await this.request<unknown>(
        "/bootstrap",
        signal ? { signal } : {},
        {
          allowWorkspaceTransition: true,
          omitWorkspaceSession: this.pendingWorkspaceSessionId !== null,
        },
      );
    } catch (error) {
      const activeSession = activeSessionFromChangedError(error);
      if (activeSession) {
        this.beginWorkspaceTransition(activeSession.id);
      }
      throw error;
    }
    const payload = parseBootstrapPayload(response);
    this.beginWorkspaceTransition(payload.session.id);
    return payload;
  }

  async listWorkspaces(): Promise<WorkspaceListResponse> {
    const response = await this.request<unknown>("/workspaces");
    return WorkspaceListResponseSchema.parse(response);
  }

  async browseDirectories(
    path: string,
    options: { showHidden?: boolean; cursor?: string } = {},
  ): Promise<WorkspaceBrowseResponse> {
    const query = new URLSearchParams({ path });
    if (options.showHidden) query.set("showHidden", "true");
    if (options.cursor) query.set("cursor", options.cursor);
    const response = await this.request<unknown>(`/fs/browse?${query.toString()}`);
    return WorkspaceBrowseResponseSchema.parse(response);
  }

  async openWorkspace(
    input: WorkspaceOpenRequest,
  ): Promise<HydratedWorkspaceOpenResponse> {
    const response = await this.request<unknown>("/workspaces/open", {
      method: "POST",
      body: JSON.stringify(input),
    });
    const parsed = WorkspaceOpenResponseSchema.parse(response);
    const bootstrap = parseBootstrapPayload(parsed.bootstrap);
    if (
      bootstrap.session.id !== parsed.session.id ||
      bootstrap.workspace.id !== parsed.session.workspaceId
    ) {
      throw new AgentRequestError(
        "La activación devolvió una sesión y un bootstrap inconsistentes.",
        409,
        "WORKSPACE_SESSION_CHANGED",
      );
    }
    this.beginWorkspaceTransition(parsed.session.id);
    return {
      ...parsed,
      bootstrap,
    };
  }

  async queryGraph(rootIds: string[], cursor?: string): Promise<GraphSnapshot> {
    const response = await this.request<unknown>("/graph/query", {
      method: "POST",
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        rootIds,
        direction: "outbound",
        relations: [],
        nodeKinds: [],
        depth: 2,
        limit: 200,
        ...(cursor ? { cursor } : {})
      })
    });
    return GraphSnapshotSchema.parse(response);
  }

  async queryGraphPage(cursor?: string): Promise<GraphSnapshot> {
    const response = await this.request<unknown>("/graph/query", {
      method: "POST",
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        rootIds: [],
        direction: "outbound",
        relations: [],
        nodeKinds: [],
        depth: 12,
        limit: 500,
        ...(cursor ? { cursor } : {}),
      }),
    });
    return GraphSnapshotSchema.parse(response);
  }

  async queryEvidenceGraph(rootIds: string[]): Promise<GraphSnapshot> {
    const response = await this.request<unknown>("/graph/query", {
      method: "POST",
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        rootIds,
        direction: "both",
        relations: [],
        nodeKinds: [],
        depth: 1,
        limit: 500,
      }),
    });
    return GraphSnapshotSchema.parse(response);
  }

  async readFile(relativePath: string) {
    const body: FileReadRequest = { protocolVersion: PROTOCOL_VERSION, relativePath };
    const response = await this.request<unknown>("/files/read", {
      method: "POST",
      body: JSON.stringify(body)
    });
    return FileReadResponseSchema.parse(response);
  }

  async getLlmConfiguration(): Promise<LlmPublicConfiguration> {
    const response = await this.request<unknown>("/settings/llm");
    return LlmPublicConfigurationSchema.parse(response);
  }

  async updateLlmConfiguration(
    configuration: LlmConfigurationUpdate,
  ): Promise<LlmPublicConfiguration> {
    const response = await this.request<unknown>("/settings/llm", {
      method: "PUT",
      body: JSON.stringify(configuration),
    });
    return LlmPublicConfigurationSchema.parse(response);
  }

  async writeFile(relativePath: string, content: string, expectedContentHash?: string) {
    if (!expectedContentHash) throw new Error("No se puede guardar sin una versión base del archivo.");
    const body: FileWriteRequest = { protocolVersion: PROTOCOL_VERSION, relativePath, content, expectedContentHash };
    const response = await this.request<unknown>("/files/write", {
      method: "PUT",
      body: JSON.stringify(body)
    });
    return FileWriteResponseSchema.parse(response);
  }

  saveLayout(layout: PanelState[], keepalive = false): Promise<void> {
    const body = JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      panels: layout,
    });
    return this.request("/layout", {
      method: "PUT",
      body,
      keepalive: keepalive && canUseKeepaliveBody(body),
    });
  }

  async createTerminal(cwd: string, panelId: string) {
    const body: TerminalCreateRequest = {
      protocolVersion: PROTOCOL_VERSION,
      cwd,
      columns: 120,
      rows: 32,
      panelId,
    };
    const response = await this.request<unknown>("/terminals", {
      method: "POST",
      body: JSON.stringify(body)
    });
    return TerminalSessionSchema.parse(response);
  }

  deleteTerminal(id: string): Promise<void> {
    return this.request(`/terminals/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async readTerminalOutput(id: string, afterSequence = 0) {
    const response = await this.request<unknown>(
      `/terminals/${encodeURIComponent(id)}/output?after=${encodeURIComponent(String(afterSequence))}`,
    );
    return TerminalOutputSnapshotSchema.parse(response);
  }

  ask(
    threadId: string,
    prompt: string,
    selectedNodeIds: string[] = [],
    requestId = crypto.randomUUID(),
  ): Promise<{ turnId: string; requestId: string; accepted: true }> {
    const body: AskTurnRequest = {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      threadId,
      prompt,
      selectedNodeIds
    };
    return this.request(`/ask/threads/${encodeURIComponent(threadId)}/turns`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  async createActTask(objective: string): Promise<ContractActTask> {
    const body: ActTaskRequest = {
      protocolVersion: PROTOCOL_VERSION,
      objective,
      capabilities: ["read", "write", "command"]
    };
    const response = await this.request<unknown>("/act/tasks", {
      method: "POST",
      body: JSON.stringify(body)
    });
    return ActTaskSchema.parse(response);
  }

  approveActTask(id: string): Promise<void> {
    const body: ActApproveRequest = { protocolVersion: PROTOCOL_VERSION, taskId: id, approved: true };
    return this.request(`/act/tasks/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  async cancelActTask(id: string): Promise<ContractActTask> {
    const response = await this.request<unknown>(
      `/act/tasks/${encodeURIComponent(id)}/cancel`,
      {
      method: "POST",
        body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION }),
      },
    );
    return ActTaskSchema.parse(response);
  }

  connect(): () => void {
    this.shouldReconnect = true;
    this.publishConnection("connecting");
    this.openSocket();
    return () => {
      this.shouldReconnect = false;
      if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
      const socket = this.socket;
      this.socket = null;
      socket?.close();
    };
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeConnection(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  subscribeWorkspaceReconciliation(
    listener: ReconciliationListener,
  ): () => void {
    this.reconciliationListeners.add(listener);
    return () => this.reconciliationListeners.delete(listener);
  }

  sendEvent(event: Record<string, unknown>): boolean {
    if (
      this.pendingWorkspaceSessionId ||
      !this.workspaceSessionId ||
      this.socket?.readyState !== WebSocket.OPEN
    ) {
      return false;
    }
    this.socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...event }));
    return true;
  }

  /**
   * Validates the staged transition, applies the UI hydration synchronously,
   * and only then makes the new session available to scoped transports.
   */
  commitHydratedWorkspace(
    sessionId: string,
    applyHydration?: () => void,
  ): void {
    const parsedSessionId =
      WorkspaceSessionSchema.shape.id.parse(sessionId);
    const pendingSessionId = this.pendingWorkspaceSessionId;
    if (pendingSessionId && pendingSessionId !== parsedSessionId) {
      throw new AgentRequestError(
        "La UI intentó confirmar una sesión distinta a la transición activa.",
        409,
        "WORKSPACE_SESSION_CHANGED",
      );
    }
    if (
      pendingSessionId === null &&
      this.workspaceSessionId !== parsedSessionId
    ) {
      throw new AgentRequestError(
        "La UI intentó confirmar una sesión que no fue preparada por el transporte.",
        409,
        "WORKSPACE_SESSION_CHANGED",
      );
    }
    applyHydration?.();
    const changed = this.workspaceSessionId !== parsedSessionId;
    const reconcileAfterCommit = this.missedPendingSessionEvents;
    this.workspaceSessionId = parsedSessionId;
    this.pendingWorkspaceSessionId = null;
    this.missedPendingSessionEvents = false;
    if (changed && pendingSessionId === null) {
      this.workspaceEpoch += 1;
    }
    if (reconcileAfterCommit) {
      queueMicrotask(() => {
        this.reconciliationListeners.forEach((listener) => listener());
      });
    }
  }

  private beginWorkspaceTransition(sessionId: string): boolean {
    if (
      this.workspaceSessionId === sessionId &&
      this.pendingWorkspaceSessionId === null
    ) {
      return false;
    }
    if (this.pendingWorkspaceSessionId === sessionId) return false;
    this.pendingWorkspaceSessionId = sessionId;
    this.missedPendingSessionEvents = false;
    this.workspaceEpoch += 1;
    return true;
  }

  private assertCurrentWorkspaceEpoch(requestEpoch: number): void {
    if (requestEpoch === this.workspaceEpoch) return;
    throw new DOMException(
      "La respuesta pertenece a una sesión de workspace anterior.",
      "AbortError",
    );
  }

  private openSocket(): void {
    if (!this.token || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;

    const socket = new WebSocket(buildEventSocketUrl(window.location, this.token));
    this.socket = socket;
    socket.addEventListener("message", (message) => {
      if (this.socket !== socket) return;
      try {
        const raw = JSON.parse(String(message.data)) as unknown;
        const event = parseServerEvent(raw);
        if (!event) return;
        if (event.type === "connection.ready") {
          this.publishConnection("connected");
          this.listeners.forEach((listener) => listener(event));
          return;
        }
        if (event.type === "workspace.changed") {
          if (this.beginWorkspaceTransition(event.payload.session.id)) {
            this.listeners.forEach((listener) => listener(event));
          }
          return;
        }
        if (this.pendingWorkspaceSessionId) {
          if (
            !event.sessionId ||
            event.sessionId === this.pendingWorkspaceSessionId
          ) {
            this.missedPendingSessionEvents = true;
          }
          return;
        }
        if (
          event.sessionId &&
          (!this.workspaceSessionId ||
            event.sessionId !== this.workspaceSessionId)
        ) {
          return;
        }
        this.listeners.forEach((listener) => listener(event));
      } catch {
        // Malformed local-agent events are ignored; the next snapshot reconciles state.
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.publishConnection("disconnected");
      if (!this.shouldReconnect) return;
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.shouldReconnect) return;
        this.publishConnection("connecting");
        this.openSocket();
      }, 1500);
    });
  }

  private publishConnection(state: SocketConnectionState): void {
    this.connectionListeners.forEach((listener) => listener(state));
  }
}

export const apiClient = new ConstelixApiClient();

export function buildEventSocketUrl(
  location: Pick<Location, "protocol" | "host">,
  token: string,
): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${location.host}/api/v1/events`);
  url.searchParams.set("token", token);
  return url.toString();
}

export function canUseKeepaliveBody(body: string): boolean {
  return new TextEncoder().encode(body).byteLength <= MAX_KEEPALIVE_BODY_BYTES;
}

export function parseServerEvent(raw: unknown): AgentEvent | null {
  const parsed = ServerEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function parseBootstrapPayload(raw: unknown): BootstrapPayload {
  const record = requireRecord(raw, "bootstrap");
  if (record.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error("El agente respondió con una versión de protocolo incompatible.");
  }
  const workspaceRecord = requireRecord(record.workspace, "workspace");
  const workspaceId = requireString(workspaceRecord.id, "workspace.id");
  const session = WorkspaceSessionSchema.parse(record.session);
  if (session.workspaceId !== workspaceId) {
    throw new Error("El agente devolvió una sesión asociada a otro workspace.");
  }
  const workspaceName = requireString(workspaceRecord.name, "workspace.name");
  const rootPath = requireString(workspaceRecord.rootPath, "workspace.rootPath");
  const mode = requireString(workspaceRecord.mode, "workspace.mode");
  if (mode !== "read" && mode !== "edit") {
    throw new Error("El agente devolvió un modo de workspace inválido.");
  }
  const readOnly = requireBoolean(workspaceRecord.readOnly, "workspace.readOnly");
  if (readOnly !== (mode === "read")) {
    throw new Error("El agente devolvió un modo de workspace inconsistente.");
  }
  const branch =
    workspaceRecord.branch === undefined
      ? undefined
      : requireString(workspaceRecord.branch, "workspace.branch");
  const graph = GraphSnapshotSchema.parse(record.graph);
  const summary = WorkspaceSummarySchema.parse(record.summary);

  const indexRecord = requireRecord(record.index, "index");
  const phases = new Set([
    "idle",
    "scanning",
    "parsing",
    "resolving",
    "persisting",
    "ready",
    "error",
  ]);
  const phase = requireString(indexRecord.phase, "index.phase");
  if (!phases.has(phase)) throw new Error("El agente devolvió una fase de indexación inválida.");
  const index = {
    phase: phase as BootstrapPayload["index"]["phase"],
    progress: requireProgress(indexRecord.progress, "index.progress"),
    filesIndexed: requireCount(indexRecord.filesIndexed, "index.filesIndexed"),
    symbolsIndexed: requireCount(indexRecord.symbolsIndexed, "index.symbolsIndexed"),
    edgesIndexed: requireCount(indexRecord.edgesIndexed, "index.edgesIndexed"),
    ...(indexRecord.message === undefined
      ? {}
      : { message: requireString(indexRecord.message, "index.message") }),
  };

  const layout =
    record.layout === undefined
      ? undefined
      : requireArray(record.layout, "layout").map((panel) =>
          PanelStateSchema.parse(panel),
        );
  const conversation =
    record.conversation === undefined
      ? undefined
      : requireArray(record.conversation, "conversation").map((message, indexValue) => {
          const messageRecord = requireRecord(
            message,
            `conversation[${indexValue}]`,
          );
          const role = requireString(
            messageRecord.role,
            `conversation[${indexValue}].role`,
          );
          if (role !== "user" && role !== "assistant") {
            throw new Error("El agente devolvió un rol de conversación inválido.");
          }
          const validatedRole: "user" | "assistant" = role;
          return {
            role: validatedRole,
            content: requireString(
              messageRecord.content,
              `conversation[${indexValue}].content`,
            ),
            ...(messageRecord.mode === undefined
              ? {}
              : { mode: parseAskMode(messageRecord.mode, `conversation[${indexValue}].mode`) }),
            ...(messageRecord.evidence === undefined
              ? {}
              : { evidence: EvidencePathSchema.parse(messageRecord.evidence) }),
            ...(messageRecord.localResult === undefined
              ? {}
              : { localResult: LocalAskResultSchema.parse(messageRecord.localResult) }),
          };
        });
  const terminals =
    record.terminals === undefined
      ? []
      : requireArray(record.terminals, "terminals").map((terminal) =>
          TerminalSessionSchema.parse(terminal),
        );
  const activeAskTurnIds = requireArray(
    record.activeAskTurnIds,
    "activeAskTurnIds",
  ).map((turnId, indexValue) =>
    requireString(turnId, `activeAskTurnIds[${indexValue}]`),
  );
  if (record.activeActTask === undefined) {
    throw new Error("Respuesta inválida del agente: activeActTask.");
  }
  const activeActTask = record.activeActTask === null
    ? null
    : ActTaskSchema.parse(record.activeActTask);

  const capabilities =
    record.capabilities === undefined
      ? undefined
      : parseCapabilities(record.capabilities);
  return {
    protocolVersion: PROTOCOL_VERSION,
    session,
    workspace: {
      id: workspaceId,
      name: workspaceName,
      rootPath,
      mode,
      readOnly,
      ...(branch ? { branch } : {}),
    },
    summary,
    graph,
    index,
    activeAskTurnIds,
    activeActTask,
    terminals,
    ...(layout ? { layout } : {}),
    ...(conversation ? { conversation } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
}

function parseCapabilities(raw: unknown): NonNullable<BootstrapPayload["capabilities"]> {
  const record = requireRecord(raw, "capabilities");
  return {
    ask: requireBoolean(record.ask, "capabilities.ask"),
    askMode: parseAskMode(record.askMode, "capabilities.askMode"),
    askProviderStatus: parseAskProviderStatus(
      record.askProviderStatus,
      "capabilities.askProviderStatus",
    ),
    act: requireBoolean(record.act, "capabilities.act"),
    terminal: requireBoolean(record.terminal, "capabilities.terminal"),
    ...(record.askNotice === undefined
      ? {}
      : { askNotice: requireString(record.askNotice, "capabilities.askNotice") }),
    ...(record.codexReason === undefined
      ? {}
      : { codexReason: requireString(record.codexReason, "capabilities.codexReason") }),
    ...(record.codexChecking === undefined
      ? {}
      : { codexChecking: requireBoolean(record.codexChecking, "capabilities.codexChecking") }),
    ...(record.codexVersion === undefined
      ? {}
      : { codexVersion: requireString(record.codexVersion, "capabilities.codexVersion") }),
    ...(record.lsp === undefined
      ? {}
      : { lsp: LspAvailabilitySchema.parse(record.lsp) }),
  };
}

function activeSessionFromChangedError(error: unknown) {
  if (
    !(error instanceof AgentRequestError) ||
    error.code !== "WORKSPACE_SESSION_CHANGED" ||
    typeof error.details !== "object" ||
    error.details === null ||
    Array.isArray(error.details)
  ) {
    return undefined;
  }
  const candidate = (error.details as Record<string, unknown>).activeSession;
  const parsed = WorkspaceSessionSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

export function parseAgentErrorDetail(detail: string): {
  message: string;
  code?: string;
  recoverable: boolean;
  severity: "info" | "warning" | "error";
  details?: unknown;
} {
  if (!detail.trim()) {
    return { message: "", recoverable: true, severity: "error" };
  }
  try {
    const parsed = JSON.parse(detail) as unknown;
    const envelope = requireRecord(parsed, "error envelope");
    const record =
      typeof envelope.error === "object" && envelope.error !== null
        ? requireRecord(envelope.error, "error")
        : envelope;
    return {
      message:
        typeof record.message === "string" && record.message.trim()
          ? record.message
          : detail,
      ...(typeof record.code === "string" ? { code: record.code } : {}),
      recoverable:
        typeof record.recoverable === "boolean" ? record.recoverable : true,
      severity:
        record.severity === "info" ||
        record.severity === "warning" ||
        record.severity === "error"
          ? record.severity
          : "error",
      ...(record.details === undefined ? {} : { details: record.details }),
    };
  } catch {
    return { message: detail, recoverable: true, severity: "error" };
  }
}

function parseAskMode(value: unknown, label: string): "local" | "openai" {
  const mode = requireString(value, label);
  if (mode !== "local" && mode !== "openai") {
    throw new Error(`Respuesta inválida del agente: ${label}.`);
  }
  return mode;
}

function parseAskProviderStatus(
  value: unknown,
  label: string,
): NonNullable<BootstrapPayload["capabilities"]>["askProviderStatus"] {
  const status = requireString(value, label);
  const accepted = new Set([
    "ready",
    "missing_api_key",
    "insufficient_quota",
    "invalid_api_key",
    "network_unavailable",
    "rate_limited",
    "unavailable",
  ]);
  if (!accepted.has(status)) {
    throw new Error(`Respuesta inválida del agente: ${label}.`);
  }
  return status as NonNullable<
    BootstrapPayload["capabilities"]
  >["askProviderStatus"];
}

function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Respuesta inválida del agente: ${label}.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Respuesta inválida del agente: ${label}.`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Respuesta inválida del agente: ${label}.`);
  }
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Respuesta inválida del agente: ${label}.`);
  }
  return value;
}

function requireProgress(value: unknown, label: string): number {
  const number = requireNumber(value, label);
  if (number < 0 || number > 1) {
    throw new Error(`Respuesta inválida del agente: ${label}.`);
  }
  return number;
}

function requireCount(value: unknown, label: string): number {
  const number = requireNumber(value, label);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`Respuesta inválida del agente: ${label}.`);
  }
  return number;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Respuesta inválida del agente: ${label}.`);
  }
  return value;
}
