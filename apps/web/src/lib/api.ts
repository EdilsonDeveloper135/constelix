import {
  FileReadResponseSchema,
  FileWriteResponseSchema,
  ServerEventSchema,
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

class ConstelixApiClient {
  private readonly token = readCapabilityToken();
  private socket: WebSocket | null = null;
  private listeners = new Set<EventListener>();
  private reconnectTimer: number | null = null;
  private shouldReconnect = true;

  get hasToken(): boolean {
    return Boolean(this.token);
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("Content-Type", "application/json");
    headers.set("X-Constelix-Protocol", String(PROTOCOL_VERSION));
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);

    const response = await fetch(`/api/v1${path}`, { ...init, headers });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(detail || `El agente respondió ${response.status}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  bootstrap(): Promise<BootstrapPayload> {
    return this.request<BootstrapPayload>("/bootstrap");
  }

  queryGraph(rootIds: string[], cursor?: string): Promise<GraphSnapshot> {
    return this.request<GraphSnapshot>("/graph/query", {
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

  saveLayout(layout: PanelState[]): Promise<void> {
    return this.request("/layout", {
      method: "PUT",
      body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, panels: layout })
    });
  }

  createTerminal(cwd: string): Promise<{ id: string; cwd: string; shell: string; createdAt: string }> {
    const body: TerminalCreateRequest = { protocolVersion: PROTOCOL_VERSION, cwd, columns: 120, rows: 32 };
    return this.request("/terminals", {
      method: "POST",
      body: JSON.stringify(body)
    });
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

  ask(threadId: string, prompt: string): Promise<{ turnId: string; requestId: string; accepted: true }> {
    const body: AskTurnRequest = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: crypto.randomUUID(),
      threadId,
      prompt,
      selectedNodeIds: []
    };
    return this.request(`/ask/threads/${encodeURIComponent(threadId)}/turns`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  createActTask(objective: string): Promise<ContractActTask> {
    const body: ActTaskRequest = {
      protocolVersion: PROTOCOL_VERSION,
      objective,
      capabilities: ["read", "write", "command"]
    };
    return this.request("/act/tasks", {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  approveActTask(id: string): Promise<void> {
    const body: ActApproveRequest = { protocolVersion: PROTOCOL_VERSION, taskId: id, approved: true };
    return this.request(`/act/tasks/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  cancelActTask(id: string): Promise<void> {
    return this.request(`/act/tasks/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION })
    });
  }

  connect(): () => void {
    this.shouldReconnect = true;
    this.openSocket();
    return () => {
      this.shouldReconnect = false;
      if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
      this.socket?.close();
      this.socket = null;
    };
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sendEvent(event: Record<string, unknown>): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...event }));
    return true;
  }

  private openSocket(): void {
    if (!this.token || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(`${protocol}//${window.location.host}/api/v1/events`);
    this.socket.addEventListener("open", () => {
      this.socket?.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: "auth", token: this.token }));
    });
    this.socket.addEventListener("message", (message) => {
      try {
        const raw = JSON.parse(String(message.data)) as unknown;
        const parsed = ServerEventSchema.safeParse(raw);
        if (parsed.success) {
          this.listeners.forEach((listener) => listener(parsed.data));
          return;
        }
        if (
          typeof raw === "object" &&
          raw !== null &&
          "protocolVersion" in raw &&
          raw.protocolVersion === PROTOCOL_VERSION &&
          "type" in raw &&
          typeof raw.type === "string"
        ) {
          this.listeners.forEach((listener) => listener(raw as AgentEvent));
        }
      } catch {
        // Malformed local-agent events are ignored; the next snapshot reconciles state.
      }
    });
    this.socket.addEventListener("close", () => {
      this.socket = null;
      if (!this.shouldReconnect) return;
      this.reconnectTimer = window.setTimeout(() => this.openSocket(), 1500);
    });
  }
}

export const apiClient = new ConstelixApiClient();
