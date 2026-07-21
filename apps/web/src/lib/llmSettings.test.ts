import { describe, expect, it } from "vitest";

import { isLoopbackLlmBaseUrl, validateLlmBaseUrl } from "./llmSettings";

describe("LLM settings validation", () => {
  it("allows HTTPS providers and loopback HTTP endpoints", () => {
    expect(validateLlmBaseUrl("https://api.openai.com/v1")).toBeNull();
    expect(validateLlmBaseUrl("http://127.0.0.1:11434/v1")).toBeNull();
    expect(validateLlmBaseUrl("http://[::1]:11434/v1")).toBeNull();
    expect(isLoopbackLlmBaseUrl("http://localhost:11434/v1")).toBe(true);
    expect(isLoopbackLlmBaseUrl("http://[::1]:11434/v1")).toBe(true);
  });

  it("rejects malformed and non-loopback plain HTTP URLs", () => {
    expect(validateLlmBaseUrl("not-a-url")).toBe("Introduce una URL válida.");
    expect(validateLlmBaseUrl("http://llm.example.com/v1")).toBe(
      "Usa HTTPS o una dirección local de loopback.",
    );
    expect(validateLlmBaseUrl("https://user:secret@example.com/v1")).toBe(
      "La URL no puede contener credenciales.",
    );
    expect(validateLlmBaseUrl("https://example.com/v1?token=secret")).toBe(
      "La URL no puede contener query ni fragmento.",
    );
  });
});
