import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  ClientEventSchema,
  ServerEventSchema,
  type ClientEvent,
} from "@constelix/contracts";
export interface LocalServerEvent {
  protocolVersion: 1;
  eventId: string;
  type: string;
  timestamp: string;
  payload: unknown;
  sessionId?: string;
  workspaceId?: string;
  [key: string]: unknown;
}

interface SocketState {
  socket: LocalWebSocket;
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

  publish(
    type: string,
    payload: unknown,
    context?: { sessionId: string; workspaceId: string },
  ): LocalServerEvent {
    const safePayload = this.sanitizePayload(payload);
    const event: LocalServerEvent = {
      protocolVersion: 1,
      eventId: randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      payload: safePayload,
      ...(context ?? {}),
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
      if (state.socket.readyState === 1) {
        try {
          state.socket.send(serialized);
        } catch {
          this.#sockets.delete(state);
          try {
            state.socket.close(1011, "WebSocket transport failed");
          } catch {
            // The failed socket is already detached.
          }
        }
      }
    }
    return event;
  }

  subscribe(listener: (event: LocalServerEvent) => void): () => void {
    this.#emitter.on("event", listener);
    return () => this.#emitter.off("event", listener);
  }

  attachAuthenticated(socket: LocalWebSocket): void {
    const state: SocketState = { socket };
    this.#sockets.add(state);

    try {
      socket.send(
        JSON.stringify({
          protocolVersion: 1,
          eventId: randomUUID(),
          type: "connection.ready",
          timestamp: new Date().toISOString(),
          payload: {},
        } satisfies LocalServerEvent),
      );
    } catch {
      this.#sockets.delete(state);
      try {
        socket.close(1011, "WebSocket transport failed");
      } catch {
        // The failed socket is already detached.
      }
      return;
    }

    socket.on("message", (raw) => {
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
      this.#sockets.delete(state);
    };
    socket.once("close", detach);
    socket.once("error", detach);
  }

  onClientMessage(listener: (message: ClientEvent) => void): () => void {
    this.#emitter.on("client-message", listener);
    return () => this.#emitter.off("client-message", listener);
  }

  dispatchClientMessage(message: ClientEvent): void {
    this.#emitter.emit("client-message", message);
  }

  close(): void {
    for (const state of this.#sockets) {
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
  "workspace.changed",
]);

function sendSocketError(
  socket: LocalWebSocket,
  code: string,
  message: string,
): void {
  try {
    socket.send(
      JSON.stringify({
        protocolVersion: 1,
        eventId: randomUUID(),
        type: "error",
        timestamp: new Date().toISOString(),
        payload: { code, message, recoverable: true },
      } satisfies LocalServerEvent),
    );
  } catch {
    try {
      socket.close(1011, "WebSocket transport failed");
    } catch {
      // The failed socket cannot receive an error frame.
    }
  }
}
