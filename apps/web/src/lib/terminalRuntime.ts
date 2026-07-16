import type {
  ConnectionState,
  TerminalRuntime,
} from "../types";

export function markTerminalRuntimeExited(
  runtimes: Readonly<Record<string, TerminalRuntime>>,
  terminalId: string,
  exitLabel: string,
): Record<string, TerminalRuntime> {
  return Object.fromEntries(
    Object.entries(runtimes).map(([panelId, runtime]) => [
      panelId,
      runtime.terminalId === terminalId
        ? { ...runtime, status: "exited" as const, exitLabel }
        : runtime,
    ]),
  );
}

export function shouldMountTerminal(
  demoMode: boolean,
  connection: ConnectionState,
  compactMode: boolean,
): boolean {
  return !compactMode && (demoMode || connection === "connected");
}

export function terminalCanAcceptInput(
  runtime: TerminalRuntime | undefined,
): boolean {
  return runtime?.status !== "exited";
}
