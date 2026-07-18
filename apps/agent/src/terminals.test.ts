import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EventBus } from "./events.js";
import { inspectWorkspace } from "./security.js";
import {
  ReadOnlyTerminalUnavailableError,
  TerminalManager,
  createTerminalLaunchCommand,
  toTerminalSessionCwd,
} from "./terminals.js";

const ptyMocks = vi.hoisted(() => {
  const child = {
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  };
  return {
    child,
    spawn: vi.fn(() => child),
  };
});

vi.mock("node-pty", () => ({ spawn: ptyMocks.spawn }));

describe("terminal launch policy", () => {
  it("launches the configured shell directly in edit mode", async () => {
    await expect(
      createTerminalLaunchCommand("/bin/zsh", false),
    ).resolves.toEqual({
      executable: "/bin/zsh",
      args: [],
    });
  });

  it("wraps read-only terminals in the macOS sandbox with writes denied", async () => {
    const ensureExecutable = vi.fn(async () => undefined);
    const launch = await createTerminalLaunchCommand("/bin/zsh", true, {
      platform: "darwin",
      sandboxExecutable: "/usr/bin/sandbox-exec",
      ensureExecutable,
    });

    expect(ensureExecutable).toHaveBeenCalledWith("/usr/bin/sandbox-exec");
    expect(launch.executable).toBe("/usr/bin/sandbox-exec");
    expect(launch.args).toHaveLength(3);
    expect(launch.args[0]).toBe("-p");
    expect(launch.args[1]).toContain("(deny file-write*)");
    expect(launch.args[2]).toBe("/bin/zsh");
  });

  it("fails safely when a read-only sandbox is unsupported or unavailable", async () => {
    await expect(
      createTerminalLaunchCommand("/bin/zsh", true, {
        platform: "linux",
        ensureExecutable: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(ReadOnlyTerminalUnavailableError);

    await expect(
      createTerminalLaunchCommand("/bin/zsh", true, {
        platform: "darwin",
        ensureExecutable: async () => {
          throw new Error("missing");
        },
      }),
    ).rejects.toThrow("sandbox-exec no está disponible");
  });

  it("exposes a workspace-relative cwd while the PTY keeps its absolute cwd", () => {
    const root = "/Users/developer/Projects/constelix";

    expect(toTerminalSessionCwd(root, root)).toBe(".");
    expect(toTerminalSessionCwd(root, join(root, "apps", "agent"))).toBe(
      "apps/agent",
    );
  });

  it("keeps absolute cwd internal to the PTY and publishes only the relative cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-terminal-cwd-"));
    const nested = join(root, "apps", "agent");
    await mkdir(nested, { recursive: true });
    const workspace = await inspectWorkspace(root);
    const publish = vi.fn();
    const events = {
      onClientMessage: vi.fn(() => () => undefined),
      publish,
    } as unknown as EventBus;
    const manager = new TerminalManager(workspace, events);
    const canonicalNested = await realpath(nested);

    const session = await manager.create({
      cwd: "apps/agent",
      shell: "/bin/zsh",
    });

    expect(ptyMocks.spawn).toHaveBeenCalledWith(
      "/bin/zsh",
      [],
      expect.objectContaining({ cwd: canonicalNested }),
    );
    expect(session.cwd).toBe("apps/agent");
    expect(manager.list()[0]?.cwd).toBe("apps/agent");
    expect(publish).toHaveBeenCalledWith(
      "terminal.created",
      expect.objectContaining({ cwd: "apps/agent" }),
    );
    manager.close();
  });
});
