import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphNode } from "@constelix/contracts";
import { describe, expect, it } from "vitest";

import {
  ASK_CONTEXT_LIMIT_BYTES,
  AskService,
  AskContextBudgetError,
  DEFAULT_ASK_MODEL,
  MAX_ASK_GRAPH_NODES,
  OpenAIUnavailableError,
  type AIProvider,
  type GraphFacade,
  compactAskContextSegments,
  isAllowedAiSnippetContent,
  isAllowedAiSnippetPath,
  measureAskRequestBytes,
  normalizeOpenAIError,
  trimAskHistoryToContextBudget,
} from "./ask.js";
import { ConstelixDatabase } from "./database.js";
import { EventBus, type LocalServerEvent } from "./events.js";

describe("normalizeOpenAIError", () => {
  it("distinguishes exhausted quota from transient rate limiting", () => {
    expect(normalizeOpenAIError({ code: "insufficient_quota", status: 429, message: "current quota" })).toEqual({
      code: "INSUFFICIENT_QUOTA",
      message: "El proyecto de OpenAI no tiene cuota disponible. Revisa la facturación o los límites de uso y vuelve a intentarlo."
    });
    expect(normalizeOpenAIError({ code: "rate_limit_exceeded", status: 429, message: "rate limit" }).code).toBe("RATE_LIMITED");
  });

  it("classifies invalid credentials without exposing the rejected key", () => {
    expect(normalizeOpenAIError({ code: "invalid_api_key", status: 401, message: "bad sk-secret" })).toEqual({
      code: "INVALID_API_KEY",
      message: "OpenAI rechazó la clave configurada. Revisa OPENAI_API_KEY en el agente local."
    });
  });

  it("classifies an unavailable network without exposing transport details", () => {
    expect(normalizeOpenAIError(new TypeError("fetch failed"))).toEqual({
      code: "NETWORK_UNAVAILABLE",
      message: "No se pudo conectar con OpenAI. Revisa la conexión de red y vuelve a intentarlo.",
    });
  });
});

describe("isAllowedAiSnippetPath", () => {
  it("keeps credentials and environment files out of AI context", () => {
    expect(isAllowedAiSnippetPath("src/index.ts")).toBe(true);
    expect(isAllowedAiSnippetPath(".env.local")).toBe(false);
    expect(isAllowedAiSnippetPath("config/private-key.pem")).toBe(false);
    expect(isAllowedAiSnippetPath(".npmrc")).toBe(false);
    expect(isAllowedAiSnippetPath(".aws/credentials")).toBe(false);
    expect(isAllowedAiSnippetPath(".config/gcloud/application_default_credentials.json")).toBe(false);
  });

  it("withholds snippets containing clear credentials without echoing them", () => {
    expect(isAllowedAiSnippetContent("export const value = 42")).toBe(true);
    expect(isAllowedAiSnippetContent("api_key=production-secret-value-1234")).toBe(false);
    expect(isAllowedAiSnippetContent("api_key=${OPENAI_API_KEY}")).toBe(true);
  });
});

describe("Ask context budget", () => {
  it("measures the complete request envelope, including instructions and tools", () => {
    const input = [{ role: "user", content: "Explain the graph" }];
    const inputBytes = Buffer.byteLength(JSON.stringify(input), "utf8");
    const requestBytes = measureAskRequestBytes(input, {
      model: DEFAULT_ASK_MODEL,
      workspaceId: "fixture",
    });

    expect(requestBytes).toBeGreaterThan(inputBytes);
    expect(requestBytes).toBeLessThan(ASK_CONTEXT_LIMIT_BYTES);
  });

  it("drops complete old history and tool rounds while retaining the current question and newest tool pair", () => {
    const history = Array.from({ length: 8 }, (_, index) => ({
      kind: "history" as const,
      items: [{ role: index % 2 === 0 ? "user" : "assistant", content: `old-${index}-${"h".repeat(36_000)}` }],
    }));
    history.push({ kind: "history", items: [{ role: "user", content: "CURRENT_QUESTION" }] });
    const oldRound = {
      kind: "tool_round" as const,
      items: [
        { type: "function_call", call_id: "old-call", name: "search_graph", arguments: "{}" },
        { type: "function_call_output", call_id: "old-call", output: "o".repeat(190_000) },
      ],
    };
    const latestRound = {
      kind: "tool_round" as const,
      items: [
        { type: "function_call", call_id: "latest-call", name: "read_snippet", arguments: "{}" },
        { type: "function_call_output", call_id: "latest-call", output: "n".repeat(50_000) },
      ],
    };

    const result = compactAskContextSegments([...history, oldRound, latestRound], {
      workspaceId: "fixture",
    });
    const serialized = JSON.stringify(result.input);

    expect(result.requestBytes).toBeLessThanOrEqual(ASK_CONTEXT_LIMIT_BYTES);
    expect(result.droppedSegments).toBeGreaterThan(0);
    expect(serialized).toContain("CURRENT_QUESTION");
    expect(serialized).toContain("latest-call");
    expect(serialized).not.toContain("old-call");
  });

  it("trims oversized persisted history and fails recoverably when the current prompt alone cannot fit", () => {
    const trimmed = trimAskHistoryToContextBudget([
      { role: "user", content: "a".repeat(150_000) },
      { role: "assistant", content: "b".repeat(100_000) },
      { role: "user", content: "latest" },
    ], { workspaceId: "fixture" });
    expect(trimmed.requestBytes).toBeLessThanOrEqual(ASK_CONTEXT_LIMIT_BYTES);
    expect(trimmed.input).toEqual([{ role: "user", content: "latest" }]);

    expect(() => trimAskHistoryToContextBudget([
      { role: "user", content: "x".repeat(ASK_CONTEXT_LIMIT_BYTES) },
    ], { workspaceId: "fixture" })).toThrow(AskContextBudgetError);
  });
});

describe("AskService provider integration", () => {
  it("stays disabled and rejects turns when no API key is configured", () => {
    const database = new ConstelixDatabase(":memory:");
    const events = new EventBus();
    const ask = new AskService(
      "workspace",
      "/tmp/workspace",
      createGraphFacade([]),
      database,
      events,
      { apiKey: "" },
    );
    try {
      expect(ask.available).toBe(false);
      expect(() => ask.startTurn("thread", "Explain the project")).toThrow(
        OpenAIUnavailableError,
      );
    } finally {
      ask.close();
      events.close();
      database.close();
    }
  });

  it("streams through an injected provider and publishes only a validated evidence path", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-ask-"));
    const source = graphNode("source", "src/source.ts");
    const middle = graphNode("middle", "src/middle.ts");
    const target = graphNode("target", "src/target.ts");
    const path = {
      protocolVersion: 1 as const,
      nodeIds: [source.id, middle.id, target.id],
      edgeIds: ["edge-source-middle", "edge-middle-target"],
      evidence: [],
      complete: true,
    };
    const provider = new ScriptedProvider([
      [{
        type: "response.completed",
        response: {
          output: [{
            type: "function_call",
            call_id: "path-call",
            name: "shortest_path",
            arguments: JSON.stringify({
              source: source.id,
              target: target.id,
              maxDepth: 8,
              useForAnswer: true,
            }),
          }],
        },
      }],
      [
        { type: "response.output_text.delta", delta: "Source reaches target." },
        { type: "response.completed", response: { output: [] } },
      ],
    ]);
    const graph = createGraphFacade([source, middle, target], { shortestPath: path });
    const fixture = createAskFixture(root, graph, provider);
    const events: LocalServerEvent[] = [];
    const unsubscribe = fixture.events.subscribe((event) => events.push(event));

    try {
      const completed = waitForEvent(
        fixture.events,
        (event) =>
          event.type === "ask.event" &&
          isRecord(event.payload) &&
          event.payload.type === "completed",
      );
      const turn = fixture.ask.startTurn(
        "thread-1",
        "Trace the relationship",
        "request-1",
        [source.id],
      );
      expect(fixture.ask.activeTurnIds).toContain(turn.turnId);
      const completedEvent = await completed;

      expect(provider.requests).toHaveLength(2);
      expect(provider.requests[0]).toMatchObject({
        model: DEFAULT_ASK_MODEL,
        store: false,
        stream: true,
        reasoning: { effort: "medium" },
      });
      expect(JSON.stringify(provider.requests[0])).toContain(source.id);
      expect(events.some((event) =>
        event.type === "ask.event" &&
        isRecord(event.payload) &&
        event.payload.type === "evidence" &&
        isRecord(event.payload.path) &&
        Array.isArray(event.payload.path.nodeIds)
      )).toBe(true);
      expect(fixture.database.loadAiMessages("thread-1").at(-1)).toMatchObject({
        role: "assistant",
        content: "Source reaches target.",
        evidence: path,
      });
      expect(completedEvent.payload).toMatchObject({
        type: "completed",
        answer: "Source reaches target.",
        evidence: path,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fixture.ask.activeTurnIds).not.toContain(turn.turnId);
    } finally {
      unsubscribe();
      fixture.ask.close();
      fixture.events.close();
      fixture.database.close();
    }
  });

  it("animates only the path explicitly selected for the final answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-ask-evidence-selection-"));
    const source = graphNode("source", "src/source.ts");
    const firstTarget = graphNode("first-target", "src/first-target.ts");
    const secondTarget = graphNode("second-target", "src/second-target.ts");
    const selectedPath = {
      protocolVersion: 1 as const,
      nodeIds: [source.id, firstTarget.id],
      edgeIds: ["edge-selected"],
      evidence: [],
      complete: true,
    };
    const exploratoryPath = {
      protocolVersion: 1 as const,
      nodeIds: [source.id, secondTarget.id],
      edgeIds: ["edge-exploratory"],
      evidence: [],
      complete: true,
    };
    const provider = new ScriptedProvider([
      [{
        type: "response.completed",
        response: {
          output: [
            {
              type: "function_call",
              call_id: "selected-path",
              name: "shortest_path",
              arguments: JSON.stringify({
                source: source.id,
                target: firstTarget.id,
                maxDepth: 8,
                useForAnswer: true,
              }),
            },
            {
              type: "function_call",
              call_id: "exploratory-path",
              name: "shortest_path",
              arguments: JSON.stringify({
                source: source.id,
                target: secondTarget.id,
                maxDepth: 8,
                useForAnswer: false,
              }),
            },
          ],
        },
      }],
      [
        { type: "response.output_text.delta", delta: "The first path supports the answer." },
        { type: "response.completed", response: { output: [] } },
      ],
    ]);
    const paths = [selectedPath, exploratoryPath];
    const graph: GraphFacade = {
      ...createGraphFacade([source, firstTarget, secondTarget]),
      shortestPath: () => paths.shift() ?? null,
    };
    const fixture = createAskFixture(root, graph, provider);

    try {
      const completed = waitForEvent(
        fixture.events,
        (event) =>
          event.type === "ask.event" &&
          isRecord(event.payload) &&
          event.payload.type === "completed",
      );
      fixture.ask.startTurn(
        "thread-evidence-selection",
        "Use the first verified path.",
        "request-evidence-selection",
      );
      const event = await completed;

      expect(event.payload).toMatchObject({
        type: "completed",
        evidence: selectedPath,
      });
      expect(
        fixture.database.loadAiMessages("thread-evidence-selection").at(-1),
      ).toMatchObject({ evidence: selectedPath });
    } finally {
      fixture.ask.close();
      fixture.events.close();
      fixture.database.close();
    }
  });

  it("enforces one aggregate graph-node budget across tool calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-ask-budget-"));
    const nodes = Array.from({ length: MAX_ASK_GRAPH_NODES + 1 }, (_, index) =>
      graphNode(`node-${index}`, `src/node-${index}.ts`));
    const provider = new ScriptedProvider([
      [{
        type: "response.completed",
        response: {
          output: [
            {
              type: "function_call",
              call_id: "search-call",
              name: "search_graph",
              arguments: JSON.stringify({ text: "node", limit: MAX_ASK_GRAPH_NODES }),
            },
            {
              type: "function_call",
              call_id: "overflow-call",
              name: "get_node",
              arguments: JSON.stringify({ nodeId: nodes.at(-1)!.id }),
            },
          ],
        },
      }],
      [
        { type: "response.output_text.delta", delta: "Budget respected." },
        { type: "response.completed", response: { output: [] } },
      ],
    ]);
    const graph = createGraphFacade(nodes, { search: nodes.slice(0, MAX_ASK_GRAPH_NODES) });
    const fixture = createAskFixture(root, graph, provider);

    try {
      const completed = waitForEvent(
        fixture.events,
        (event) =>
          event.type === "ask.event" &&
          isRecord(event.payload) &&
          event.payload.type === "completed",
      );
      fixture.ask.startTurn("thread-budget", "Inspect every node", "request-budget");
      await completed;

      const nextInput = provider.requests[1]?.input;
      const overflowOutput = Array.isArray(nextInput)
        ? nextInput.find((item) =>
            isRecord(item) &&
            item.type === "function_call_output" &&
            item.call_id === "overflow-call")
        : undefined;
      expect(overflowOutput).toMatchObject({
        type: "function_call_output",
        call_id: "overflow-call",
      });
      expect(JSON.parse(String((overflowOutput as Record<string, unknown>).output))).toMatchObject({
        code: "ASK_GRAPH_NODE_LIMIT",
      });
    } finally {
      fixture.ask.close();
      fixture.events.close();
      fixture.database.close();
    }
  });

  it("completes without an animated path when the graph cannot prove the relationship", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-ask-no-path-"));
    const source = graphNode("source", "src/source.ts");
    const target = graphNode("target", "src/target.ts");
    const provider = new ScriptedProvider([
      [{
        type: "response.completed",
        response: {
          output: [{
            type: "function_call",
            call_id: "missing-path",
            name: "shortest_path",
            arguments: JSON.stringify({
              source: source.id,
              target: target.id,
              maxDepth: 8,
              useForAnswer: false,
            }),
          }],
        },
      }],
      [
        { type: "response.output_text.delta", delta: "La evidencia disponible es insuficiente." },
        { type: "response.completed", response: { output: [] } },
      ],
    ]);
    const fixture = createAskFixture(
      root,
      createGraphFacade([source, target], { shortestPath: null }),
      provider,
    );
    const published: LocalServerEvent[] = [];
    const unsubscribe = fixture.events.subscribe((event) => published.push(event));

    try {
      const completed = waitForEvent(
        fixture.events,
        (event) =>
          event.type === "ask.event" &&
          isRecord(event.payload) &&
          event.payload.type === "completed",
      );
      fixture.ask.startTurn("thread-no-path", "Prove the relationship", "request-no-path");
      await completed;

      expect(published.some((event) =>
        event.type === "ask.event" &&
        isRecord(event.payload) &&
        event.payload.type === "evidence"
      )).toBe(false);
      expect(fixture.database.loadAiMessages("thread-no-path").at(-1)).toEqual({
        role: "assistant",
        content: "La evidencia disponible es insuficiente.",
      });
    } finally {
      unsubscribe();
      fixture.ask.close();
      fixture.events.close();
      fixture.database.close();
    }
  });

  it("reports a recoverable error when a provider stream ends without completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-ask-stream-"));
    const provider = new ScriptedProvider([[{ type: "response.output_text.delta", delta: "partial" }]]);
    const fixture = createAskFixture(root, createGraphFacade([]), provider);

    try {
      const failed = waitForEvent(
        fixture.events,
        (event) => event.type === "ask.turn.error",
      );
      fixture.ask.startTurn("thread-stream", "Explain", "request-stream");
      const event = await failed;

      expect(event.payload).toMatchObject({
        code: "OPENAI_ERROR",
        message: "OpenAI stream ended before response.completed.",
      });
    } finally {
      fixture.ask.close();
      fixture.events.close();
      fixture.database.close();
    }
  });

  it("cancels an active provider stream and emits a terminal cancellation event", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-ask-cancel-"));
    const fixture = createAskFixture(root, createGraphFacade([]), new BlockingProvider());

    try {
      const cancelled = waitForEvent(
        fixture.events,
        (event) => event.type === "ask.turn.cancelled",
      );
      const turn = fixture.ask.startTurn("thread-cancel", "Explain", "request-cancel");
      expect(fixture.ask.cancel(turn.turnId)).toBe(true);
      const event = await cancelled;

      expect(event.payload).toMatchObject({
        code: "CANCELLED",
        message: "La consulta fue cancelada.",
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fixture.ask.cancel(turn.turnId)).toBe(false);
    } finally {
      fixture.ask.close();
      fixture.events.close();
      fixture.database.close();
    }
  });
});

class ScriptedProvider implements AIProvider {
  readonly requests: Array<Record<string, unknown>> = [];

  constructor(private readonly scripts: Array<Array<Record<string, unknown>>>) {}

  async stream(
    request: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<AsyncIterable<Record<string, unknown>>> {
    this.requests.push(request);
    const events = this.scripts.shift();
    if (!events) throw new Error("No scripted response remains.");
    return (async function* () {
      for (const event of events) {
        if (signal.aborted) throw signal.reason;
        yield event;
      }
    })();
  }
}

class BlockingProvider implements AIProvider {
  async stream(
    _request: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<AsyncIterable<Record<string, unknown>>> {
    return (async function* () {
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      yield { type: "response.completed", response: { output: [] } };
    })();
  }
}

function createAskFixture(root: string, graph: GraphFacade, provider: AIProvider) {
  const database = new ConstelixDatabase(":memory:");
  database.upsertWorkspace("workspace", root);
  const events = new EventBus();
  const ask = new AskService("workspace", root, graph, database, events, {
    provider,
    model: DEFAULT_ASK_MODEL,
    turnTimeoutMs: 5_000,
  });
  return { ask, database, events };
}

function createGraphFacade(
  nodes: readonly GraphNode[],
  overrides: { search?: unknown; shortestPath?: unknown } = {},
): GraphFacade {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return {
    getNode: (id) => byId.get(id),
    snapshot: () => ({
      protocolVersion: 1,
      workspaceId: "workspace",
      revision: 1,
      nodes: [...nodes],
      edges: [],
      truncated: false,
    }),
    query: () => ({ nodes: [], edges: [] }),
    search: () => overrides.search ?? [],
    neighbors: () => ({ nodes: [], edges: [] }),
    shortestPath: () => overrides.shortestPath ?? null,
  };
}

function graphNode(id: string, relativePath: string): GraphNode {
  return {
    protocolVersion: 1,
    id,
    kind: "function",
    name: id,
    qualifiedName: id,
    relativePath,
    language: "typescript",
    revision: 1,
    metadata: {},
  };
}

function waitForEvent(
  events: EventBus,
  predicate: (event: LocalServerEvent) => boolean,
): Promise<LocalServerEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for Ask event."));
    }, 5_000);
    const unsubscribe = events.subscribe((event) => {
      if (!predicate(event)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
