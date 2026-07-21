import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  LlmConfigurationError,
  LlmConfigurationStore,
  canUseLlmConfiguration,
  normalizeLlmBaseUrl,
  resolveLlmConfiguration,
  toPublicLlmConfiguration,
} from "./llm-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("LLM configuration", () => {
  it("applies saved, modern environment, legacy environment, and default precedence", () => {
    expect(resolveLlmConfiguration({ environment: {} })).toMatchObject({
      baseUrl: DEFAULT_LLM_BASE_URL,
      model: DEFAULT_LLM_MODEL,
      apiKeySource: "none",
    });

    expect(resolveLlmConfiguration({
      environment: {
        OPENAI_API_KEY: "legacy-key",
        CONSTELIX_OPENAI_MODEL: "legacy-model",
      },
    })).toMatchObject({
      model: "legacy-model",
      apiKey: "legacy-key",
      apiKeySource: "environment",
    });

    expect(resolveLlmConfiguration({
      environment: {
        LLM_BASE_URL: "https://modern.example/v1",
        LLM_MODEL: "modern-model",
        LLM_API_KEY: "modern-key",
        OPENAI_API_KEY: "legacy-key",
        CONSTELIX_OPENAI_MODEL: "legacy-model",
      },
    })).toMatchObject({
      baseUrl: "https://modern.example/v1",
      model: "modern-model",
      apiKey: "modern-key",
      apiKeySource: "environment",
    });

    expect(resolveLlmConfiguration({
      environment: {
        LLM_BASE_URL: "https://environment.example/v1",
        LLM_MODEL: "environment-model",
        LLM_API_KEY: "environment-key",
      },
      stored: {
        baseUrl: "https://saved.example/v1",
        model: "saved-model",
        apiKey: "saved-key",
      },
    })).toMatchObject({
      baseUrl: "https://saved.example/v1",
      model: "saved-model",
      apiKey: "saved-key",
      apiKeySource: "stored",
    });

    const localWithLegacyRemoteKey = resolveLlmConfiguration({
      environment: { OPENAI_API_KEY: "remote-openai-key" },
      stored: {
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "local-model",
      },
    });
    expect(localWithLegacyRemoteKey).toMatchObject({
      providerKind: "ollama",
      apiKeySource: "none",
    });
    expect(localWithLegacyRemoteKey.apiKey).toBeUndefined();
    expect(resolveLlmConfiguration({
      environment: {
        LLM_BASE_URL: "http://127.0.0.1:11434/v1",
        LLM_API_KEY: "explicit-local-key",
      },
    })).toMatchObject({
      apiKey: "explicit-local-key",
      apiKeySource: "environment",
    });
  });

  it("allows loopback HTTP without a key and rejects unsafe remote URLs", () => {
    const local = resolveLlmConfiguration({
      environment: {
        LLM_BASE_URL: "http://127.0.0.1:11434/v1/",
        LLM_MODEL: "qwen2.5-coder:7b",
      },
    });

    expect(local).toMatchObject({
      baseUrl: "http://127.0.0.1:11434/v1",
      providerKind: "ollama",
      apiKeyRequired: false,
      apiKeySource: "none",
    });
    expect(canUseLlmConfiguration(local)).toBe(true);
    expect(() => normalizeLlmBaseUrl("http://remote.example/v1")).toThrow(
      LlmConfigurationError,
    );
    expect(() => normalizeLlmBaseUrl("https://user:pass@example.com/v1")).toThrow(
      /credenciales/,
    );
    expect(() => normalizeLlmBaseUrl("https://example.com/v1?token=secret")).toThrow(
      /query/,
    );
  });

  it("persists settings and secrets separately with private permissions", async () => {
    const parent = await mkdtemp(join(tmpdir(), "constelix-llm-settings-"));
    temporaryDirectories.push(parent);
    const directory = join(parent, "state");
    const secret = "stored-secret-for-test";
    const store = new LlmConfigurationStore(directory, {});

    const saved = await store.update({
      protocolVersion: 1,
      baseUrl: "https://compatible.example/v1/",
      model: "compatible-model",
      apiKey: { action: "replace", value: secret },
    });
    expect(saved).toMatchObject({
      baseUrl: "https://compatible.example/v1",
      model: "compatible-model",
      apiKey: secret,
      apiKeySource: "stored",
    });

    const settingsText = await readFile(store.settingsPath, "utf8");
    expect(settingsText).not.toContain(secret);
    const secretDocument = JSON.parse(
      await readFile(store.secretPath, "utf8"),
    ) as { apiKey: string; baseUrl: string; secretId: string };
    expect(secretDocument).toMatchObject({
      apiKey: secret,
      baseUrl: "https://compatible.example/v1",
    });
    expect(secretDocument.secretId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(store.settingsPath)).mode & 0o777).toBe(0o600);
    expect((await stat(store.secretPath)).mode & 0o777).toBe(0o600);

    const restarted = await new LlmConfigurationStore(directory, {
      LLM_MODEL: "ignored-environment-model",
      LLM_API_KEY: "ignored-environment-key",
    }).load();
    expect(restarted).toMatchObject({
      model: "compatible-model",
      apiKey: secret,
      apiKeySource: "stored",
    });
    const publicConfiguration = toPublicLlmConfiguration(restarted);
    expect(publicConfiguration.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(publicConfiguration)).not.toContain(secret);
    expect(Object.hasOwn(publicConfiguration, "apiKey")).toBe(false);

    const switchedProvider = await store.update({
      protocolVersion: 1,
      baseUrl: "http://localhost:11434/v1",
      model: "llama3.2",
      apiKey: { action: "preserve" },
    });
    expect(switchedProvider.apiKey).toBeUndefined();
    expect(switchedProvider.apiKeySource).toBe("none");
    await expect(readFile(store.secretPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const explicitLocalKey = await store.update({
      protocolVersion: 1,
      baseUrl: "http://localhost:11434/v1",
      model: "llama3.2",
      apiKey: { action: "replace", value: "explicit-local-key" },
    });
    expect(explicitLocalKey.apiKey).toBe("explicit-local-key");

    const cleared = await store.update({
      protocolVersion: 1,
      baseUrl: "http://localhost:11434/v1",
      model: "llama3.2",
      apiKey: { action: "clear" },
    });
    expect(cleared.apiKey).toBeUndefined();
    expect(toPublicLlmConfiguration(cleared)).toMatchObject({
      providerKind: "ollama",
      apiKeyConfigured: false,
      apiKeyRequired: false,
    });
  });

  it("fails closed when a crash leaves a new secret with old settings", async () => {
    const parent = await mkdtemp(join(tmpdir(), "constelix-llm-transaction-"));
    temporaryDirectories.push(parent);
    const store = new LlmConfigurationStore(join(parent, "state"), {});
    await store.update({
      protocolVersion: 1,
      baseUrl: "https://provider-a.example/v1",
      model: "model-a",
      apiKey: { action: "replace", value: "provider-a-key" },
    });

    // This is the durable state after the secret rename succeeds but the
    // settings rename for a provider-B update never happens.
    await writeFile(
      store.secretPath,
      `${JSON.stringify({
        version: 1,
        secretId: randomUUID(),
        baseUrl: "https://provider-b.example/v1",
        apiKey: "provider-b-key",
      })}\n`,
      { mode: 0o600 },
    );

    const recovered = await store.load();
    expect(recovered).toMatchObject({
      baseUrl: "https://provider-a.example/v1",
      apiKeySource: "none",
    });
    expect(recovered.apiKey).toBeUndefined();
  });
});
