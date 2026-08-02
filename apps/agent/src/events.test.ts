import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import {
  EventBus,
  MAX_EVENT_SOCKET_BUFFER_BYTES,
  MAX_EVENT_SOCKETS,
} from "./events.js";

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closed: Array<{ code?: number; reason?: string }> = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed.push({
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    });
    this.readyState = 3;
    this.emit("close");
  }
}

describe("EventBus transport bounds", () => {
  it("rejects authenticated sockets beyond the connection cap", () => {
    const events = new EventBus();
    const sockets = Array.from(
      { length: MAX_EVENT_SOCKETS + 1 },
      () => new FakeSocket(),
    );

    sockets.forEach((socket) => events.attachAuthenticated(socket));

    expect(
      sockets
        .slice(0, MAX_EVENT_SOCKETS)
        .every((socket) => socket.sent.length === 1 && socket.closed.length === 0),
    ).toBe(true);
    expect(sockets.at(-1)?.closed).toEqual([
      { code: 4429, reason: "Too many event connections" },
    ]);
    events.close();
  });

  it("disconnects a client whose outbound buffer exceeds the bound", () => {
    const events = new EventBus();
    const socket = new FakeSocket();
    events.attachAuthenticated(socket);
    socket.bufferedAmount = MAX_EVENT_SOCKET_BUFFER_BYTES + 1;

    events.publish("terminal.output", {
      terminalId: "terminal-one",
      data: "output",
      sequence: 1,
    });

    expect(socket.sent).toHaveLength(1);
    expect(socket.closed).toEqual([
      { code: 1013, reason: "Event backpressure limit exceeded" },
    ]);
    events.close();
  });
});
