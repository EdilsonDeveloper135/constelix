import { Plus, SquareTerminal, Trash2 } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { NodeProps } from "@xyflow/react";

import { demoTerminalLines } from "../../data/demo";
import { apiClient } from "../../lib/api";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import type { TerminalFlowNode } from "../../types";
import { PanelFrame } from "./PanelFrame";

function terminalPrompt(cwd: string): string {
  return `\r\n\u001b[36mconstelix\u001b[0m:${cwd} \u001b[33m(main)\u001b[0m $ `;
}

interface TerminalOutputDetail {
  terminalId: string;
  data: string;
  sequence?: number;
}

export const TerminalPanel = memo(function TerminalPanel({ id, data, height }: NodeProps<TerminalFlowNode>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const demoMode = useWorkspaceStore((state) => state.demoMode);
  const createTerminal = useWorkspaceStore((state) => state.createTerminal);
  const [ready, setReady] = useState(false);
  const [restartKey, setRestartKey] = useState(0);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let terminalSessionId: string | undefined;
    let removeOutputListener: (() => void) | null = null;
    let hydratingOutput = false;
    let bufferedOutput: TerminalOutputDetail[] = [];
    let latestOutputSequence = 0;

    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(async ([xtermModule, fitModule]) => {
      if (disposed) return;
      const terminal = new xtermModule.Terminal({
        allowProposedApi: false,
        cursorBlink: true,
        cursorStyle: "bar",
        convertEol: true,
        fontFamily: "SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: 11,
        lineHeight: 1.35,
        scrollback: 5000,
        theme: {
          background: "#0d1314",
          foreground: "#c4cdcf",
          cursor: "#65cfe2",
          black: "#182023",
          brightBlack: "#607074",
          green: "#78c96a",
          brightGreen: "#8fe17e",
          cyan: "#65cfe2",
          yellow: "#d9b85d",
          magenta: "#bd8bdd",
          red: "#e36d71"
        }
      });
      const fitAddon = new fitModule.FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(host);
      fitAddon.fit();
      setReady(true);

      const writeOutput = (output: TerminalOutputDetail) => {
        if (output.sequence !== undefined) {
          if (output.sequence <= latestOutputSequence) return;
          latestOutputSequence = output.sequence;
        }
        terminal.write(output.data);
      };
      const onOutput = (event: Event) => {
        const detail = (event as CustomEvent<TerminalOutputDetail>).detail;
        if (detail.terminalId !== terminalSessionId) return;
        if (hydratingOutput) {
          bufferedOutput.push(detail);
          return;
        }
        writeOutput(detail);
      };
      window.addEventListener("constelix:terminal-output", onOutput);
      removeOutputListener = () => window.removeEventListener("constelix:terminal-output", onOutput);

      if (!demoMode && !terminalSessionId) {
        try {
          const session = await apiClient.createTerminal(data.cwd);
          terminalSessionId = session.id;
          if (disposed) {
            await apiClient.deleteTerminal(session.id).catch(() => undefined);
            return;
          }

          terminal.writeln(`\u001b[90mPTY · ${session.cwd}\u001b[0m`);
          hydratingOutput = true;
          try {
            const snapshot = await apiClient.readTerminalOutput(session.id);
            for (const chunk of snapshot.chunks) writeOutput({ terminalId: session.id, ...chunk });
          } catch {
            // Live terminal output remains available when transcript recovery is unavailable.
          } finally {
            const pendingOutput = bufferedOutput;
            bufferedOutput = [];
            pendingOutput.sort((left, right) => (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER));
            for (const output of pendingOutput) writeOutput(output);
            hydratingOutput = false;
          }
        } catch {
          terminal.writeln("\u001b[31mNo se pudo iniciar la PTY local. Ejecutando consola degradada.\u001b[0m");
        }
      }

      if (demoMode || !terminalSessionId) {
        demoTerminalLines.forEach((line) => terminal.writeln(line));
        terminal.write(terminalPrompt(data.cwd));
      }

      let inputBuffer = "";
      const inputDisposable = terminal.onData((chunk) => {
        if (terminalSessionId && !demoMode) {
          apiClient.sendEvent({ type: "terminal.input", terminalId: terminalSessionId, data: chunk });
          return;
        }
        if (chunk === "\r") {
          terminal.write("\r\n");
          const command = inputBuffer.trim();
          if (command === "clear") terminal.clear();
          else if (command) terminal.writeln(`\u001b[90m[demo]\u001b[0m ${command}: ejecución disponible al conectar el agente local.`);
          inputBuffer = "";
          terminal.write(terminalPrompt(data.cwd).slice(2));
          return;
        }
        if (chunk === "\u007f") {
          if (inputBuffer.length) {
            inputBuffer = inputBuffer.slice(0, -1);
            terminal.write("\b \b");
          }
          return;
        }
        if (chunk >= " ") {
          inputBuffer += chunk;
          terminal.write(chunk);
        }
      });

      resizeObserver = new ResizeObserver(() => {
        window.requestAnimationFrame(() => {
          if (disposed) return;
          fitAddon.fit();
          if (terminalSessionId) {
            apiClient.sendEvent({ type: "terminal.resize", terminalId: terminalSessionId, cols: terminal.cols, rows: terminal.rows });
          }
        });
      });
      resizeObserver.observe(host);

      if (disposed) {
        inputDisposable.dispose();
        terminal.dispose();
        return;
      }

      const dispose = () => {
        inputDisposable.dispose();
        terminal.dispose();
      };
      host.dataset.disposeReady = "true";
      (host as HTMLDivElement & { disposeTerminal?: () => void }).disposeTerminal = dispose;
    });

    return () => {
      disposed = true;
      setReady(false);
      resizeObserver?.disconnect();
      removeOutputListener?.();
      const disposableHost = host as HTMLDivElement & { disposeTerminal?: () => void };
      disposableHost.disposeTerminal?.();
      if (terminalSessionId && !demoMode) void apiClient.deleteTerminal(terminalSessionId).catch(() => undefined);
      host.replaceChildren();
    };
  }, [data.cwd, demoMode, restartKey]);

  return (
    <PanelFrame
      id={id}
      title={data.title}
      icon={<SquareTerminal aria-hidden="true" size={14} />}
      minWidth={340}
      minHeight={190}
      currentHeight={height}
      accent="green"
      className="terminal-panel"
      actions={
        <>
          <button type="button" aria-label="Nueva terminal" onClick={() => createTerminal(data.cwd, data.anchorNodeId)}><Plus aria-hidden="true" size={14} /></button>
          <button type="button" aria-label="Limpiar terminal" onClick={() => setRestartKey((key) => key + 1)}><Trash2 aria-hidden="true" size={13} /></button>
        </>
      }
    >
      {!ready ? <div className="panel-loading panel-loading--terminal"><span /> Iniciando PTY…</div> : null}
      <div className="terminal-host" ref={containerRef} aria-label={`Terminal en ${data.cwd}`} data-testid="terminal-panel" />
    </PanelFrame>
  );
});
