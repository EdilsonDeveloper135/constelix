import {
  LlmConnectionTestResponseSchema,
  type LlmConnectionTestResponse,
} from "@constelix/contracts";

import type { ResolvedLlmConfiguration } from "./llm-config.js";

const CONNECTION_TIMEOUT_MS = 8_000;

export async function testLlmConnection(
  configuration: ResolvedLlmConfiguration,
  fetchImplementation: typeof fetch = fetch,
): Promise<LlmConnectionTestResponse> {
  const startedAt = performance.now();
  let ok = false;
  let message: string;

  if (configuration.apiKeyRequired && !configuration.apiKey) {
    message = "Configura una clave API para comprobar este proveedor remoto.";
  } else {
    try {
      const response = await fetchImplementation(
        `${configuration.baseUrl.replace(/\/$/u, "")}/models`,
        {
          method: "GET",
          ...(configuration.apiKey
            ? { headers: { Authorization: `Bearer ${configuration.apiKey}` } }
            : {}),
          signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
        },
      );
      ok = response.ok;
      message = response.ok
        ? "Conexión correcta. El endpoint y las credenciales respondieron."
        : `El proveedor respondió con HTTP ${response.status}. Revisa la URL, la clave y los permisos.`;
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      message =
        error instanceof DOMException && error.name === "TimeoutError"
          ? "El proveedor no respondió dentro de 8 segundos."
          : "No se pudo conectar con el proveedor. Revisa la URL, la red o el servicio local.";
    }
  }

  return LlmConnectionTestResponseSchema.parse({
    protocolVersion: 1,
    ok,
    providerKind: configuration.providerKind,
    model: configuration.model,
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    message,
  });
}
