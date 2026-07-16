import { describe, expect, it } from "vitest";

import {
  ASK_CONTEXT_LIMIT_BYTES,
  AskContextBudgetError,
  DEFAULT_ASK_MODEL,
  compactAskContextSegments,
  isAllowedAiSnippetContent,
  isAllowedAiSnippetPath,
  measureAskRequestBytes,
  normalizeOpenAIError,
  trimAskHistoryToContextBudget,
} from "./ask.js";

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
