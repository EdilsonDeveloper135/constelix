import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import * as pty from "node-pty";
import type { EventBus } from "./events.js";
import { resolveExistingWorkspacePath } from "./security.js";

interface TerminalSession {
  id: string;
  cwd: string;
  process: pty.IPty;
  createdAt: string;
  outputChunks: TerminalOutputChunk[];
  outputBytes: number;
  latestSequence: number;
  exited: boolean;
}

interface TerminalOutputChunk {
  sequence: number;
  data: string;
}

const MAX_OUTPUT_HISTORY_BYTES = 256 * 1024;

export class TerminalManager {
  readonly #sessions = new Map<string, TerminalSession>();
  readonly #unsubscribe: () => void;

  constructor(
    private readonly workspaceRoot: string,
    private readonly events: EventBus,
  ) {
    this.#unsubscribe = events.onClientMessage((message) => {
      const terminalId = typeof message.terminalId === "string" ? message.terminalId : undefined;
      if (!terminalId) return;
      if (message.type === "terminal.input" && typeof message.data === "string") {
        this.write(terminalId, message.data);
      }
      if (
        message.type === "terminal.resize" &&
        typeof message.cols === "number" &&
        typeof message.rows === "number"
      ) {
        this.resize(terminalId, message.cols, message.rows);
      }
    });
  }

  async create(options: {
    cwd?: string;
    cols?: number;
    rows?: number;
    shell?: string;
  }): Promise<{ id: string; cwd: string; shell: string; createdAt: string }> {
    await ensureNodePtyHelper();
    const cwd = options.cwd
      ? await resolveExistingWorkspacePath(this.workspaceRoot, options.cwd)
      : this.workspaceRoot;
    const shell = options.shell ?? process.env.SHELL ?? (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");
    const terminalEnvironment = { ...process.env };
    delete terminalEnvironment.OPENAI_API_KEY;
    delete terminalEnvironment.CONSTELIX_CAPABILITY_TOKEN;
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const child = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: clamp(options.cols ?? 100, 20, 500),
      rows: clamp(options.rows ?? 30, 5, 200),
      cwd,
      env: {
        ...terminalEnvironment,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        CONSTELIX_WORKSPACE: this.workspaceRoot,
      } as Record<string, string>,
      encoding: "utf8",
    });

    const session: TerminalSession = {
      id,
      cwd,
      process: child,
      createdAt,
      outputChunks: [],
      outputBytes: 0,
      latestSequence: 0,
      exited: false,
    };
    this.#sessions.set(id, session);
    child.onData((data) => {
      const sequence = session.latestSequence + 1;
      session.latestSequence = sequence;
      appendOutput(session, { sequence, data });
      this.events.publish("terminal.output", { terminalId: id, data, sequence });
    });
    child.onExit(({ exitCode, signal }) => {
      session.exited = true;
      this.events.publish("terminal.exit", { terminalId: id, exitCode, signal });
    });
    this.events.publish("terminal.created", { terminalId: id, cwd, shell, createdAt });
    return { id, cwd, shell, createdAt };
  }

  write(id: string, data: string): void {
    const session = this.#sessions.get(id);
    if (!session || session.exited) return;
    session.process.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.#sessions.get(id);
    if (!session || session.exited) return;
    session.process.resize(clamp(cols, 20, 500), clamp(rows, 5, 200));
  }

  remove(id: string): boolean {
    const session = this.#sessions.get(id);
    if (!session) return false;
    if (!session.exited) session.process.kill();
    this.#sessions.delete(id);
    return true;
  }

  list(): Array<{ id: string; cwd: string; createdAt: string }> {
    return [...this.#sessions.values()].map(({ id, cwd, createdAt }) => ({ id, cwd, createdAt }));
  }

  readOutput(
    id: string,
    afterSequence = 0,
  ): { chunks: TerminalOutputChunk[]; latestSequence: number; truncated: boolean } | null {
    const session = this.#sessions.get(id);
    if (!session) return null;
    const firstAvailableSequence = session.outputChunks[0]?.sequence ?? session.latestSequence + 1;
    return {
      chunks: session.outputChunks.filter((chunk) => chunk.sequence > afterSequence),
      latestSequence: session.latestSequence,
      truncated: afterSequence < firstAvailableSequence - 1,
    };
  }

  close(): void {
    this.#unsubscribe();
    for (const session of this.#sessions.values()) {
      if (!session.exited) session.process.kill();
    }
    this.#sessions.clear();
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function appendOutput(session: TerminalSession, chunk: TerminalOutputChunk): void {
  session.outputChunks.push(chunk);
  session.outputBytes += Buffer.byteLength(chunk.data);
  while (session.outputBytes > MAX_OUTPUT_HISTORY_BYTES && session.outputChunks.length > 1) {
    const removed = session.outputChunks.shift();
    if (removed) session.outputBytes -= Buffer.byteLength(removed.data);
  }
}

async function ensureNodePtyHelper(): Promise<void> {
  if (process.platform !== "darwin") return;
  const require = createRequire(import.meta.url);
  const packageEntry = require.resolve("node-pty");
  const helper = resolve(
    dirname(packageEntry),
    "..",
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );
  try {
    await access(helper, constants.X_OK);
  } catch {
    // Some package managers lose the executable bit when unpacking node-pty.
    // Restoring it is required before macOS can create a PTY.
    await chmod(helper, 0o755);
  }
}
