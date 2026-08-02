import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  chmod,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  LlmPublicConfigurationSchema,
  type LlmApiKeySource,
  type LlmConfigurationUpdate,
  type LlmProviderKind,
  type LlmPublicConfiguration,
} from "@constelix/contracts";
import { z } from "zod";

export const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_LLM_MODEL = "gpt-4o";

const MAX_BASE_URL_LENGTH = 2_048;
const MAX_MODEL_LENGTH = 256;
const MAX_PRIVATE_FILE_BYTES = 32 * 1024;

const StoredLlmConfigurationSchema = z.object({
  version: z.literal(1),
  baseUrl: z.string().min(1).max(MAX_BASE_URL_LENGTH),
  model: z.string().min(1).max(MAX_MODEL_LENGTH),
  secretId: z.string().uuid().optional(),
}).strict();

const StoredLlmSecretSchema = z.object({
  version: z.literal(1),
  secretId: z.string().uuid(),
  baseUrl: z.string().min(1).max(MAX_BASE_URL_LENGTH),
  apiKey: z.string().min(1).max(8_192),
}).strict();

interface StoredLlmConfiguration {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface LlmConfigurationOverrides {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export interface ResolvedLlmConfiguration {
  baseUrl: string;
  model: string;
  providerKind: LlmProviderKind;
  apiKey?: string;
  apiKeySource: LlmApiKeySource;
  apiKeyRequired: boolean;
}

export class LlmConfigurationError extends Error {
  readonly code = "LLM_CONFIGURATION_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "LlmConfigurationError";
  }
}

export class LlmConfigurationStore {
  readonly settingsPath: string;
  readonly secretPath: string;

  constructor(
    private readonly storageDirectory: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.settingsPath = resolve(storageDirectory, "llm-settings.json");
    this.secretPath = resolve(storageDirectory, "llm-api-key");
  }

  async load(): Promise<ResolvedLlmConfiguration> {
    await ensurePrivateDirectory(this.storageDirectory);
    const storedSettings = await this.readSettings();
    const storedSecret = await this.readSecret();
    const secretMatchesProvider =
      storedSettings?.secretId !== undefined &&
      storedSettings.secretId === storedSecret?.secretId &&
      storedSettings.baseUrl === storedSecret.baseUrl;
    return resolveLlmConfiguration({
      environment: this.environment,
      ...(storedSettings === undefined
        ? {}
        : {
            stored: {
              baseUrl: storedSettings.baseUrl,
              model: storedSettings.model,
              ...(!secretMatchesProvider || storedSecret === undefined
                ? {}
                : { apiKey: storedSecret.apiKey }),
            },
          }),
    });
  }

  async update(input: LlmConfigurationUpdate): Promise<ResolvedLlmConfiguration> {
    await ensurePrivateDirectory(this.storageDirectory);
    const baseUrl = normalizeLlmBaseUrl(input.baseUrl);
    const model = normalizeLlmModel(input.model);
    const currentSettings = await this.readSettings();
    let secretId = currentSettings?.secretId;

    if (input.apiKey.action === "replace") {
      const replacement = normalizeApiKey(input.apiKey.value);
      if (replacement === undefined) {
        throw new LlmConfigurationError("LLM_API_KEY no puede estar vacía al reemplazarla.");
      }
      secretId = randomUUID();
      await writePrivateFile(
        this.secretPath,
        `${JSON.stringify({
          version: 1,
          secretId,
          baseUrl,
          apiKey: replacement,
        })}\n`,
      );
    } else if (input.apiKey.action === "clear") {
      await rm(this.secretPath, { force: true });
      secretId = undefined;
    } else if (currentSettings?.baseUrl !== baseUrl) {
      // A credential is bound to the provider URL where the user supplied it.
      // Never forward a preserved remote key to a newly selected local daemon
      // (or to any other compatible provider).
      await rm(this.secretPath, { force: true });
      secretId = undefined;
    }

    await writePrivateFile(
      this.settingsPath,
      `${JSON.stringify({
        version: 1,
        baseUrl,
        model,
        ...(secretId === undefined ? {} : { secretId }),
      }, null, 2)}\n`,
    );
    return this.load();
  }

  private async readSettings(): Promise<z.infer<typeof StoredLlmConfigurationSchema> | undefined> {
    const raw = await readPrivateFile(this.settingsPath);
    if (raw === undefined) return undefined;
    try {
      return StoredLlmConfigurationSchema.parse(JSON.parse(raw) as unknown);
    } catch {
      throw new LlmConfigurationError(
        "La configuración LLM guardada no es válida. Corrige o elimina llm-settings.json.",
      );
    }
  }

  private async readSecret(): Promise<z.infer<typeof StoredLlmSecretSchema> | undefined> {
    const raw = await readPrivateFile(this.secretPath);
    if (raw === undefined) return undefined;
    try {
      return StoredLlmSecretSchema.parse(JSON.parse(raw) as unknown);
    } catch {
      throw new LlmConfigurationError(
        "La credencial LLM guardada no es válida. Elimina llm-api-key y vuelve a configurarla.",
      );
    }
  }
}

export function resolveLlmConfiguration(options: {
  environment?: NodeJS.ProcessEnv;
  stored?: StoredLlmConfiguration;
  overrides?: LlmConfigurationOverrides;
} = {}): ResolvedLlmConfiguration {
  const environment = options.environment ?? process.env;
  const overrides = options.overrides;
  const hasApiKeyOverride = overrides !== undefined &&
    Object.prototype.hasOwnProperty.call(overrides, "apiKey");
  const baseUrl = normalizeLlmBaseUrl(
    overrides?.baseUrl ??
      options.stored?.baseUrl ??
      nonEmpty(environment.LLM_BASE_URL) ??
      DEFAULT_LLM_BASE_URL,
  );
  const model = normalizeLlmModel(
    overrides?.model ??
      options.stored?.model ??
      nonEmpty(environment.LLM_MODEL) ??
      nonEmpty(environment.CONSTELIX_OPENAI_MODEL) ??
      DEFAULT_LLM_MODEL,
  );

  let apiKey: string | undefined;
  let apiKeySource: LlmApiKeySource = "none";
  if (hasApiKeyOverride) {
    apiKey = normalizeApiKey(overrides?.apiKey);
  } else if (normalizeApiKey(options.stored?.apiKey) !== undefined) {
    apiKey = normalizeApiKey(options.stored?.apiKey);
    apiKeySource = "stored";
  } else {
    const environmentBaseUrl = normalizeLlmBaseUrl(
      nonEmpty(environment.LLM_BASE_URL) ?? DEFAULT_LLM_BASE_URL,
    );
    const modernApiKey = normalizeApiKey(environment.LLM_API_KEY);
    const legacyApiKey = normalizeApiKey(environment.OPENAI_API_KEY);
    apiKey = environmentBaseUrl === baseUrl
      ? modernApiKey ??
        (baseUrl === DEFAULT_LLM_BASE_URL ? legacyApiKey : undefined)
      : undefined;
    if (apiKey !== undefined) apiKeySource = "environment";
  }

  const loopback = isLoopbackLlmBaseUrl(baseUrl);
  return {
    baseUrl,
    model,
    providerKind: detectProviderKind(baseUrl),
    ...(apiKey === undefined ? {} : { apiKey }),
    apiKeySource,
    apiKeyRequired: !loopback,
  };
}

export function applyLlmConfigurationOverrides(
  configuration: ResolvedLlmConfiguration,
  overrides: LlmConfigurationOverrides,
): ResolvedLlmConfiguration {
  const hasApiKeyOverride = Object.prototype.hasOwnProperty.call(overrides, "apiKey");
  const providerChanged = overrides.baseUrl !== undefined &&
    normalizeLlmBaseUrl(overrides.baseUrl) !== configuration.baseUrl;
  const resolved = resolveLlmConfiguration({
    environment: {},
    stored: {
      baseUrl: configuration.baseUrl,
      model: configuration.model,
      ...(providerChanged || configuration.apiKey === undefined
        ? {}
        : { apiKey: configuration.apiKey }),
    },
    overrides,
  });
  return {
    ...resolved,
    apiKeySource:
      hasApiKeyOverride || providerChanged ? "none" : configuration.apiKeySource,
  };
}

export function toPublicLlmConfiguration(
  configuration: ResolvedLlmConfiguration,
): LlmPublicConfiguration {
  return LlmPublicConfigurationSchema.parse({
    protocolVersion: 1,
    baseUrl: configuration.baseUrl,
    model: configuration.model,
    providerKind: configuration.providerKind,
    apiKeyConfigured: configuration.apiKey !== undefined,
    apiKeyRequired: configuration.apiKeyRequired,
    apiKeySource: configuration.apiKeySource,
  });
}

export function canUseLlmConfiguration(configuration: ResolvedLlmConfiguration): boolean {
  return !configuration.apiKeyRequired || configuration.apiKey !== undefined;
}

export function effectiveLlmApiKey(configuration: ResolvedLlmConfiguration): string {
  if (configuration.apiKey !== undefined) return configuration.apiKey;
  if (!configuration.apiKeyRequired) return "ollama";
  throw new LlmConfigurationError("LLM_API_KEY es obligatoria para endpoints remotos.");
}

export function normalizeLlmBaseUrl(value: string): string {
  const candidate = value.trim();
  if (candidate.length === 0 || candidate.length > MAX_BASE_URL_LENGTH) {
    throw new LlmConfigurationError("LLM_BASE_URL debe tener entre 1 y 2048 caracteres.");
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new LlmConfigurationError("LLM_BASE_URL debe ser una URL HTTP o HTTPS válida.");
  }
  if (parsed.username || parsed.password) {
    throw new LlmConfigurationError("LLM_BASE_URL no puede contener credenciales embebidas.");
  }
  if (parsed.search || parsed.hash) {
    throw new LlmConfigurationError("LLM_BASE_URL no puede contener query ni fragmento.");
  }
  const loopback = isLoopbackHostname(parsed.hostname);
  if (parsed.protocol === "http:" && !loopback) {
    throw new LlmConfigurationError("Los endpoints LLM remotos deben usar HTTPS.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new LlmConfigurationError("LLM_BASE_URL solo admite los protocolos HTTP y HTTPS.");
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
  return parsed.toString().replace(/\/$/u, parsed.pathname === "/" ? "" : "");
}

export function normalizeLlmModel(value: string): string {
  const model = value.trim();
  if (model.length === 0 || model.length > MAX_MODEL_LENGTH || /[\u0000-\u001f\u007f]/u.test(model)) {
    throw new LlmConfigurationError(
      "LLM_MODEL debe tener entre 1 y 256 caracteres y no contener controles.",
    );
  }
  return model;
}

export function isLoopbackLlmBaseUrl(value: string): boolean {
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

function detectProviderKind(baseUrl: string): LlmProviderKind {
  const parsed = new URL(baseUrl);
  if (parsed.hostname.toLowerCase() === "api.openai.com") return "openai";
  if (isLoopbackHostname(parsed.hostname) && parsed.port === "11434") return "ollama";
  return "compatible";
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function normalizeApiKey(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function readPrivateFile(path: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new LlmConfigurationError(`${basename(path)} debe ser un archivo regular.`);
    }
    if (metadata.size > MAX_PRIVATE_FILE_BYTES) {
      throw new LlmConfigurationError(
        `${basename(path)} supera el límite seguro de ${MAX_PRIVATE_FILE_BYTES} bytes.`,
      );
    }
    await chmod(path, 0o600);
    const noFollow =
      typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile() ||
      openedMetadata.dev !== metadata.dev ||
      openedMetadata.ino !== metadata.ino ||
      openedMetadata.size > MAX_PRIVATE_FILE_BYTES
    ) {
      throw new LlmConfigurationError(
        `${basename(path)} cambió mientras se leía.`,
      );
    }
    await handle.chmod(0o600);
    const buffer = Buffer.allocUnsafe(MAX_PRIVATE_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_PRIVATE_FILE_BYTES) {
      throw new LlmConfigurationError(
        `${basename(path)} supera el límite seguro de ${MAX_PRIVATE_FILE_BYTES} bytes.`,
      );
    }
    return buffer.subarray(0, offset).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temporaryPath = resolve(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
