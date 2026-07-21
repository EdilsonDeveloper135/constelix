export const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_LLM_MODEL = "gpt-4o";

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackLlmBaseUrl(value: string): boolean {
  try {
    return loopbackHosts.has(normalizeHostname(new URL(value).hostname));
  } catch {
    return false;
  }
}

export function validateLlmBaseUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Introduce una URL válida.";
  }
  if (url.username || url.password) {
    return "La URL no puede contener credenciales.";
  }
  if (url.search || url.hash) {
    return "La URL no puede contener query ni fragmento.";
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && loopbackHosts.has(normalizeHostname(url.hostname))) {
    return null;
  }
  return "Usa HTTPS o una dirección local de loopback.";
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/gu, "");
}
