import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  ClientEventSchema,
  ServerEventSchema,
  WebSocketAuthenticationSchema,
  type ClientEvent,
} from "@constelix/contracts";
export interface LocalServerEvent {
  protocolVersion: 1;
  eventId: string;
  type: string;
  timestamp: string;
  payload: unknown;
  [key: string]: unknown;
}

interface SocketState {
  authenticated: boolean;
  socket: LocalWebSocket;
  timeout: NodeJS.Timeout;
}

interface LocalWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (raw: { toString(): string }) => void): void;
  once(event: "close" | "error", listener: () => void): void;
}

export class EventBus {
  readonly #emitter = new EventEmitter();
  readonly #sockets = new Set<SocketState>();

  constructor(
    private readonly sanitizePayload: (payload: unknown) => unknown = (payload) => payload,
  ) {}

  publish(type: string, payload: unknown): LocalServerEvent {
    const safePayload = this.sanitizePayload(payload);
    const event: LocalServerEvent = {
      protocolVersion: 1,
      eventId: randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      payload: safePayload,
    };
    this.#emitter.emit("event", event);
    const transportEvent = ServerEventSchema.safeParse(event);
    if (!transportEvent.success) {
      if (TRANSPORT_EVENT_TYPES.has(type)) {
        throw new Error(`Invalid outbound WebSocket event: ${type}`);
      }
      return event;
    }
    const serialized = JSON.stringify(transportEvent.data);
    for (const state of this.#sockets) {
      if (state.authenticated && state.socket.readyState === 1) {
        state.socket.send(serialized);
      }
    }
    return event;
  }

  subscribe(listener: (event: LocalServerEvent) => void): () => void {
    this.#emitter.on("event", listener);
    return () => this.#emitter.off("event", listener);
  }

  attach(socket: LocalWebSocket, capabilityToken: string): void {
    const state: SocketState = {
      authenticated: false,
      socket,
      timeout: setTimeout(() => socket.close(4401, "Authentication timeout"), 2_000),
    };
    state.timeout.unref();
    this.#sockets.add(state);

    socket.on("message", (raw) => {
      if (!state.authenticated) {
        try {
          const parsed = WebSocketAuthenticationSchema.safeParse(
            JSON.parse(raw.toString()) as unknown,
          );
          if (!parsed.success || parsed.data.token !== capabilityToken) {
            socket.close(4401, "Unauthorized");
            return;
          }
          state.authenticated = true;
          clearTimeout(state.timeout);
          socket.send(
            JSON.stringify({
              protocolVersion: 1,
              eventId: randomUUID(),
              type: "authenticated",
              timestamp: new Date().toISOString(),
              payload: {},
            } satisfies LocalServerEvent),
          );
          socket.send(
            JSON.stringify({
              protocolVersion: 1,
              eventId: randomUUID(),
              type: "connection.ready",
              timestamp: new Date().toISOString(),
              payload: {},
            } satisfies LocalServerEvent),
          );
          return;
        } catch {
          socket.close(4400, "Invalid authentication message");
          return;
        }
      }

      try {
        const message = ClientEventSchema.parse(
          JSON.parse(raw.toString()) as unknown,
        );
        this.#emitter.emit("client-message", message);
      } catch {
        sendSocketError(
          socket,
          "INVALID_MESSAGE",
          "The WebSocket message is malformed or violates protocol version 1.",
        );
      }
    });

    const detach = () => {
      clearTimeout(state.timeout);
      this.#sockets.delete(state);
    };
    socket.once("close", detach);
    socket.once("error", detach);
  }

  onClientMessage(listener: (message: ClientEvent) => void): () => void {
    this.#emitter.on("client-message", listener);
    return () => this.#emitter.off("client-message", listener);
  }

  close(): void {
    for (const state of this.#sockets) {
      clearTimeout(state.timeout);
      state.socket.close(1001, "Server shutting down");
    }
    this.#sockets.clear();
    this.#emitter.removeAllListeners();
  }
}

const TRANSPORT_EVENT_TYPES = new Set([
  "graph.delta",
  "graph.snapshot",
  "index.progress",
  "terminal.output",
  "terminal.exit",
  "ask.event",
  "capabilities.updated",
  "act.event",
  "error",
]);

function sendSocketError(
  socket: LocalWebSocket,
  code: string,
  message: string,
): void {
  socket.send(
    JSON.stringify({
      protocolVersion: 1,
      eventId: randomUUID(),
      type: "error",
      timestamp: new Date().toISOString(),
      payload: { code, message, recoverable: true },
    } satisfies LocalServerEvent),
  );
}
