import type {
  ConnectionState,
  WorkspaceAskMode,
  WorkspaceMode,
} from "../types";

export function connectionLabel(
  connection: ConnectionState,
  demoMode: boolean,
): string {
  if (demoMode) return "Modo demostración";
  if (connection === "connected") return "Agente local conectado";
  if (connection === "connecting") return "Conectando con el agente…";
  return "Agente local desconectado";
}

export function workspaceModeLabel(mode: WorkspaceMode): string {
  return mode === "read" ? "Lectura" : "Edición";
}

export function askModeLabel(mode: WorkspaceAskMode): string {
  return mode === "local" ? "Ask Local" : "Ask LLM";
}

export function summarizeWorkspacePath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join("/")}`;
}
