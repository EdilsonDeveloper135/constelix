import { Plus, RotateCcw, SquareTerminal, Trash2 } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { NodeProps } from "@xyflow/react";

import { demoTerminalLines } from "../../data/demo";
import { apiClient } from "../../lib/api";
import {
  shouldMountTerminal,
  terminalCanAcceptInput,
} from "../../lib/terminalRuntime";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import type { TerminalFlowNode } from "../../types";
import { PanelFrame } from "./PanelFrame";

function terminalPrompt(cwd: string): string {
  return `\r\n\u001b[36mconstelix\u001b[0m:${cwd} \u001b[33m(main)\u001b[0m $ `;
}

function mountCwdFor(id: string, fallback: string): string {
  const currentNode = useWorkspaceStore
    .getState()
    .nodes.find((node) => node.id === id);
  return currentNode?.type === "terminalPanel" ? currentNode.data.cwd : fallback;
}

interface TerminalOutputDetail {
  terminalId: string;
  data: string;
  sequence?: number;
}

interface TerminalHost extends HTMLDivElement {
  disposeTerminal?: () => void;
  clearTerminal?: () => void;
}

type TerminalPanelProps = Pick<
  NodeProps<TerminalFlowNode>,
  "id" | "data" | "height"
> & { docked?: boolean };

export const TerminalPanel = memo(function TerminalPanel({
  id,
  data,
  height,
  docked = false,
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const demoMode = useWorkspaceStore((state) => state.demoMode);
  const connection = useWorkspaceStore((state) => state.connection);
  const canvasCompactMode = useWorkspaceStore((state) => state.compactMode);
  const compactMode = !docked && canvasCompactMode;
  const createTerminal = useWorkspaceStore((state) => state.createTerminal);
  const runtime = useWorkspaceStore((state) => state.terminalRuntimes[id]);
  // Effect 2 (DOM mounting) below intentionally depends on these primitive
  // fields rather than `runtime` itself: selecting the whole object makes
  // the dependency change on every registerTerminalRuntime call, including
  // the one effect 1 issues for a session effect 2 already has mounted,
  // which tore the just-created xterm instance down and rebuilt it.
  const runtimeTerminalId = runtime?.terminalId;
  const runtimeCwd = runtime?.cwd;
  const runtimeStatus = runtime?.status;
  const registerTerminalRuntime = useWorkspaceStore(
    (state) => state.registerTerminalRuntime,
  );
  const clearTerminalRuntime = useWorkspaceStore(
    (state) => state.clearTerminalRuntime,
  );
  const [ready, setReady] = useState(false);
  const [transcriptTruncated, setTranscriptTruncated] = useState(false);
  // Guards against a duplicate PTY: React (in development, Strict Mode)
  // invokes an effect, cleans it up, and invokes it again on first mount.
  // Without this ref, both invocations can see "no runtime yet" before
  // either request resolves and each create their own real session.
  const creatingSessionRef = useRef(false);

  // Effect 1: ensure a server-side PTY session exists for this panel's
  // current cwd. Deliberately owns no DOM/xterm state, so re-running it
  // (including the run its own registerTerminalRuntime call triggers) is
  // cheap and side-effect-free once a matching session is already known.
  useEffect(() => {
    if (demoMode || !shouldMountTerminal(demoMode, connection, compactMode)) {
      return;
    }
    const mountCwd = mountCwdFor(id, data.cwd);
    const currentRuntime = useWorkspaceStore.getState().terminalRuntimes[id];
    if (currentRuntime && currentRuntime.cwd !== mountCwd) {
      void apiClient.deleteTerminal(currentRuntime.terminalId).catch(() => undefined);
      clearTerminalRuntime(id);
      return;
    }
    if (currentRuntime || creatingSessionRef.current) return;

    // Deliberately not using a per-invocation "cancelled" flag set from
    // this effect's own cleanup: React (in development, Strict Mode)
    // cleans up and re-invokes this effect once on mount even though the
    // panel is still very much wanted, and that phantom cleanup must not
    // discard the session this call is about to create. Instead, check
    // for a real removal (the panel node itself gone, e.g. via
    // closePanel) once the request actually resolves.
    creatingSessionRef.current = true;
    void apiClient
      .createTerminal(mountCwd, id)
      .then((session) => {
        creatingSessionRef.current = false;
        const stillWanted = useWorkspaceStore
          .getState()
          .nodes.some((node) => node.id === id);
        if (!stillWanted) {
          void apiClient.deleteTerminal(session.id).catch(() => undefined);
          return;
        }
        registerTerminalRuntime(id, {
          terminalId: session.id,
          cwd: mountCwd,
          status: "running",
        });
      })
      .catch(() => {
        creatingSessionRef.current = false;
        // Effect 2 falls back to a local degraded console when no session
        // ever becomes available.
      });
  }, [
    clearTerminalRuntime,
    compactMode,
    connection,
    data.cwd,
    demoMode,
    id,
    registerTerminalRuntime,
    runtime,
  ]);

  // Effect 2: mount xterm.js against whatever session is currently known.
  // Keyed by stable primitives so it re-runs only on a genuine session
  // change (created, exited, cwd reassigned) or a real viewport/connection
  // change — never as an echo of this effect's own writes, because this
  // effect never calls registerTerminalRuntime itself.
  useEffect(() => {
    if (!shouldMountTerminal(demoMode, connection, compactMode)) {
      setReady(false);
      return;
    }
    const host = containerRef.current as TerminalHost | null;
    if (!host) return;
    setTranscriptTruncated(false);
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    const mountCwd = mountCwdFor(id, data.cwd);
    const currentRuntime = useWorkspaceStore.getState().terminalRuntimes[id];
    const terminalSessionId =
      currentRuntime?.cwd === mountCwd ? currentRuntime.terminalId : undefined;
    const terminalExited = currentRuntime?.status === "exited";
    let removeOutputListener: (() => void) | null = null;
    let hydratingOutput = false;
    let bufferedOutput: TerminalOutputDetail[] = [];
    let latestOutputSequence = 0;
    let warnedDisconnected = false;

    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
    ]).then(async ([xtermModule, fitModule]) => {
      if (disposed) return;
      const terminal = new xtermModule.Terminal({
        allowProposedApi: false,
        cursorBlink: true,
        cursorStyle: "bar",
        convertEol: true,
        fontFamily:
          "SFMono-Regular, Menlo, Monaco, Consolas, monospace",
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
          red: "#e36d71",
        },
      });
      const fitAddon = new fitModule.FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(host);
      fitAddon.fit();
      setReady(true);
      if (disposed) {
        // The effect was cleaned up while the xterm/fit-addon modules were
        // still loading. No disposeTerminal callback has been registered
        // on `host` yet for the earlier run to have called, so this run
        // owns disposing what it just created.
        terminal.dispose();
        return;
      }

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
      removeOutputListener = () =>
        window.removeEventListener("constelix:terminal-output", onOutput);

      if (!demoMode && terminalSessionId) {
        terminal.writeln(
          `\u001b[90mPTY · ${mountCwd} · sesión ${terminalSessionId.slice(0, 8)}\u001b[0m`,
        );
        hydratingOutput = true;
        try {
          const snapshot = await apiClient.readTerminalOutput(
            terminalSessionId,
          );
          for (const chunk of snapshot.chunks) {
            writeOutput({ terminalId: terminalSessionId, ...chunk });
          }
          latestOutputSequence = Math.max(
            latestOutputSequence,
            snapshot.latestSequence,
          );
          setTranscriptTruncated(snapshot.truncated);
        } catch {
          // Live output remains available when transcript recovery is unavailable.
        } finally {
          const pendingOutput = bufferedOutput;
          bufferedOutput = [];
          pendingOutput.sort(
            (left, right) =>
              (left.sequence ?? Number.MAX_SAFE_INTEGER) -
              (right.sequence ?? Number.MAX_SAFE_INTEGER),
          );
          for (const output of pendingOutput) writeOutput(output);
          hydratingOutput = false;
        }
        if (disposed) {
          removeOutputListener?.();
          terminal.dispose();
          return;
        }
        if (terminalExited || !terminalCanAcceptInput(currentRuntime)) {
          terminal.write(
            `\r\n\u001b[90m[${currentRuntime?.exitLabel ?? "proceso terminado"}]\u001b[0m\r\n`,
          );
        }
      }

      if (demoMode || !terminalSessionId) {
        demoTerminalLines.forEach((line) => terminal.writeln(line));
        terminal.write(terminalPrompt(mountCwd));
      }

      let inputBuffer = "";
      const inputDisposable = terminal.onData((chunk) => {
        if (terminalExited) {
          terminal.write(
            "\r\n\u001b[33mLa sesión terminó. Usa “Reiniciar terminal” para crear una PTY nueva.\u001b[0m\r\n",
          );
          return;
        }
        if (terminalSessionId && !demoMode) {
          const sent = apiClient.sendEvent({
            type: "terminal.input",
            terminalId: terminalSessionId,
            data: chunk,
          });
          if (!sent && !warnedDisconnected) {
            warnedDisconnected = true;
            terminal.write(
              "\r\n\u001b[31mConexión con el agente interrumpida; la PTY se conserva para reconciliar al volver.\u001b[0m\r\n",
            );
          }
          return;
        }
        if (chunk === "\r") {
          terminal.write("\r\n");
          const command = inputBuffer.trim();
          if (command === "clear") {
            terminal.clear();
          } else if (command) {
            terminal.writeln(
              `\u001b[90m[demo]\u001b[0m ${command}: ejecución disponible al conectar el agente local.`,
            );
          }
          inputBuffer = "";
          terminal.write(terminalPrompt(mountCwd).slice(2));
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

      if (disposed) {
        removeOutputListener?.();
        inputDisposable.dispose();
        terminal.dispose();
        return;
      }

      resizeObserver = new ResizeObserver(() => {
        window.requestAnimationFrame(() => {
          if (disposed) return;
          fitAddon.fit();
          if (terminalSessionId) {
            apiClient.sendEvent({
              type: "terminal.resize",
              terminalId: terminalSessionId,
              cols: terminal.cols,
              rows: terminal.rows,
            });
          }
        });
      });
      resizeObserver.observe(host);

      const dispose = () => {
        inputDisposable.dispose();
        terminal.dispose();
      };
      host.dataset.disposeReady = "true";
      host.disposeTerminal = dispose;
      host.clearTerminal = () => terminal.clear();
    });

    return () => {
      disposed = true;
      setReady(false);
      resizeObserver?.disconnect();
      removeOutputListener?.();
      host.disposeTerminal?.();
      delete host.disposeTerminal;
      delete host.clearTerminal;
      host.replaceChildren();
    };
  }, [
    compactMode,
    connection,
    data.cwd,
    demoMode,
    id,
    runtimeCwd,
    runtimeStatus,
    runtimeTerminalId,
  ]);

  return (
    <PanelFrame
      id={id}
      title={data.title}
      icon={<SquareTerminal aria-hidden="true" size={14} />}
      minWidth={340}
      minHeight={190}
      currentHeight={height}
      collapsed={data.collapsed}
      expandedHeight={data.expandedHeight}
      accent="green"
      className="terminal-panel"
      docked={docked}
      dockTarget="bottom"
      actions={
        <>
          <button
            type="button"
            aria-label="Nueva terminal"
            onClick={() => createTerminal(data.cwd, data.anchorNodeId, data.dock)}
          >
            <Plus aria-hidden="true" size={14} />
          </button>
          <button
            type="button"
            aria-label="Limpiar terminal"
            onClick={() =>
              (containerRef.current as TerminalHost | null)?.clearTerminal?.()
            }
          >
            <Trash2 aria-hidden="true" size={13} />
          </button>
          {runtime?.status === "exited" ? (
            <button
              type="button"
              aria-label="Reiniciar terminal"
              onClick={() => {
                void apiClient.deleteTerminal(runtime.terminalId).catch(() => undefined);
                clearTerminalRuntime(id);
              }}
            >
              <RotateCcw aria-hidden="true" size={13} />
            </button>
          ) : null}
        </>
      }
    >
      {!ready ? (
        <div className="panel-loading panel-loading--terminal">
          <span /> Iniciando PTY…
        </div>
      ) : null}
      {transcriptTruncated ? (
        <div className="terminal-transcript-warning" role="status">
          El historial anterior fue truncado; la sesión continúa activa.
        </div>
      ) : null}
      <div
        className="terminal-host"
        ref={containerRef}
        aria-label={`Terminal en ${data.cwd}`}
        data-testid="terminal-panel"
      />
    </PanelFrame>
  );
});
