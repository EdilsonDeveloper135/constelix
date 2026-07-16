import {
  ActTaskSchema,
  EvidencePathSchema,
  FileReadResponseSchema,
  FileWriteResponseSchema,
  GraphSnapshotSchema,
  PanelStateSchema,
  ServerEventSchema,
  TerminalSessionSchema,
  TerminalOutputSnapshotSchema,
  type ActApproveRequest,
  type ActTask as ContractActTask,
  type ActTaskRequest,
  type AskTurnRequest,
  type FileReadRequest,
  type FileWriteRequest,
  type GraphSnapshot,
  type PanelState,
  type TerminalCreateRequest
} from "@constelix/contracts";

import { PROTOCOL_VERSION, type AgentEvent, type BootstrapPayload } from "../types";
import { readCapabilityToken } from "./auth";

type EventListener = (event: AgentEvent) => void;
type SocketConnectionState = "connecting" | "connected" | "disconnected";
type ConnectionListener = (state: SocketConnectionState) => void;
const MAX_KEEPALIVE_BODY_BYTES = 60 * 1024;

export class AgentRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AgentRequestError";
  }
}

class ConstelixApiClient {
  private readonly token = readCapabilityToken();
  private socket: WebSocket | null = null;
  private listeners = new Set<EventListener>();
  private connectionListeners = new Set<ConnectionListener>();
  private reconnectTimer: number | null = null;
  private shouldReconnect = true;

  get hasToken(): boolean {
    return Boolean(this.token);
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined && init.body !== null) {
      headers.set("Content-Type", "application/json");
    }
    headers.set("X-Constelix-Protocol", String(PROTOCOL_VERSION));
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);

    const response = await fetch(`/api/v1${path}`, { ...init, headers });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new AgentRequestError(
        detail || `El agente respondió ${response.status}`,
        response.status,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async bootstrap(signal?: AbortSignal): Promise<BootstrapPayload> {
    const response = await this.request<unknown>(
      "/bootstrap",
      signal ? { signal } : {},
    );
    return parseBootstrapPayload(response);
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

  sendEvent(event: Record<string, unknown>): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...event }));
    return true;
  }

  private openSocket(): void {
    if (!this.token || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/v1/events`);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      socket.send(JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "authenticate",
        token: this.token,
      }));
    });
    socket.addEventListener("message", (message) => {
      if (this.socket !== socket) return;
      try {
        const raw = JSON.parse(String(message.data)) as unknown;
        const event = parseServerEvent(raw);
        if (!event) return;
        if (event.type === "connection.ready") {
          this.publishConnection("connected");
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
  const workspaceName = requireString(workspaceRecord.name, "workspace.name");
  const rootPath = requireString(workspaceRecord.rootPath, "workspace.rootPath");
  const branch =
    workspaceRecord.branch === undefined
      ? undefined
      : requireString(workspaceRecord.branch, "workspace.branch");
  const graph = GraphSnapshotSchema.parse(record.graph);

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
            ...(messageRecord.evidence === undefined
              ? {}
              : { evidence: EvidencePathSchema.parse(messageRecord.evidence) }),
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
    workspace: {
      id: workspaceId,
      name: workspaceName,
      rootPath,
      ...(branch ? { branch } : {}),
    },
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
    act: requireBoolean(record.act, "capabilities.act"),
    terminal: requireBoolean(record.terminal, "capabilities.terminal"),
    ...(record.codexReason === undefined
      ? {}
      : { codexReason: requireString(record.codexReason, "capabilities.codexReason") }),
  };
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
