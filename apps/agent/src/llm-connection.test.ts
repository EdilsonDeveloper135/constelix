import { describe, expect, it, vi } from "vitest";

import { testLlmConnection } from "./llm-connection";
import type { ResolvedLlmConfiguration } from "./llm-config";

const localConfiguration: ResolvedLlmConfiguration = {
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "qwen2.5-coder:7b",
  providerKind: "ollama",
  apiKeyRequired: false,
  apiKeySource: "none",
};

describe("LLM connection diagnostics", () => {
  it("verifies a responsive OpenAI-compatible models endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));

    await expect(
      testLlmConnection(localConfiguration, fetchMock as typeof fetch),
    ).resolves.toMatchObject({
      ok: true,
      providerKind: "ollama",
      model: "qwen2.5-coder:7b",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("explains missing credentials without making a network request", async () => {
    const fetchMock = vi.fn();
    const result = await testLlmConnection(
      {
        ...localConfiguration,
        baseUrl: "https://api.openai.com/v1",
        providerKind: "openai",
        apiKeyRequired: true,
      },
      fetchMock as typeof fetch,
    );

    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining("clave API"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns HTTP failures into actionable diagnostics", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 401 }));
    const result = await testLlmConnection(
      { ...localConfiguration, apiKey: "secret", apiKeySource: "stored" },
      fetchMock as typeof fetch,
    );

    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining("HTTP 401"),
    });
  });
});
