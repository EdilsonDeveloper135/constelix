import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectWorkspaceLock,
  type ProcessInspector,
  WorkspaceLease,
  WorkspaceLeaseLostError,
  WorkspaceLockConflictError,
  WorkspaceLockExpectedOwnerError,
  type WorkspaceLockMetadataV1,
  type WorkspaceLockOptions,
} from "./workspace-lock.js";

const roots: string[] = [];
const EXECUTABLE = "/opt/constelix/node";
const START_TIME = Date.parse("2026-07-25T22:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("WorkspaceLease", () => {
  it("writes v1 metadata, renews mtime, classifies its owner as active, and releases idempotently", async () => {
    const fixture = await createFixture();
    const clock = createClock();
    const inspector = createProcessInspector({
      42: { liveness: "alive", executablePath: EXECUTABLE },
    });
    const lease = await WorkspaceLease.acquire(
      leaseOptions(fixture, clock, inspector),
    );

    const stored = JSON.parse(
      await readFile(fixture.lockPath, "utf8"),
    ) as WorkspaceLockMetadataV1;
    expect(stored).toEqual({
      version: 1,
      lockId: lease.metadata.lockId,
      pid: 42,
      bootTimestamp: "2026-07-25T21:59:59.000Z",
      execPath: EXECUTABLE,
      agentVersion: "v0.0.5",
      workspaceId: "workspace-test",
      workspacePath: fixture.workspacePath,
      createdAt: "2026-07-25T22:00:00.000Z",
    });

    await expect(
      inspectWorkspaceLock(
        inspectOptions(fixture, clock, inspector),
      ),
    ).resolves.toMatchObject({
      classification: "active",
      reason: "owner-active",
      lockId: lease.metadata.lockId,
    });

    clock.advance(5_000);
    await lease.refreshHeartbeat();
    expect((await lstat(fixture.lockPath)).mtimeMs).toBeCloseTo(clock.now(), -1);

    await expect(Promise.all([lease.release(), lease.release()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    await expect(access(fixture.lockPath)).rejects.toThrow();
  });

  it("rejects both normal and forced acquisition while the owner is active", async () => {
    const fixture = await createFixture();
    const clock = createClock();
    const inspector = createProcessInspector({
      42: { liveness: "alive", executablePath: EXECUTABLE },
    });
    const options = leaseOptions(fixture, clock, inspector);
    const owner = await WorkspaceLease.acquire(options);
    try {
      await expect(WorkspaceLease.acquire(options)).rejects.toBeInstanceOf(
        WorkspaceLockConflictError,
      );
      await expect(
        WorkspaceLease.acquire({
          ...options,
          force: { expectedLockId: owner.metadata.lockId },
        }),
      ).rejects.toBeInstanceOf(WorkspaceLockConflictError);
      expect(await access(fixture.lockPath)).toBeUndefined();
    } finally {
      await owner.release();
    }
  });

  it("auto-heals a recycled PID when ps reports a different executable", async () => {
    const fixture = await createFixture();
    const clock = createClock();
    await writeV1Lock(fixture, clock, {
      lockId: "recycled-owner",
      pid: 77,
      execPath: "/opt/constelix/old-node",
    });
    const inspector = createProcessInspector({
      77: { liveness: "alive", executablePath: "/Applications/Spotify" },
      42: { liveness: "alive", executablePath: EXECUTABLE },
    });

    await expect(
      inspectWorkspaceLock(
        inspectOptions(fixture, clock, inspector),
      ),
    ).resolves.toMatchObject({
      classification: "stale-safe",
      reason: "executable-mismatch",
      lockId: "recycled-owner",
    });

    const lease = await WorkspaceLease.acquire(
      leaseOptions(fixture, clock, inspector),
    );
    try {
      expect(lease.metadata.lockId).not.toBe("recycled-owner");
    } finally {
      await lease.release();
    }
  });

  it("requires an exact lock id to force an ambiguous stale heartbeat", async () => {
    const fixture = await createFixture();
    const clock = createClock();
    await writeV1Lock(
      fixture,
      clock,
      {
        lockId: "hung-owner",
        pid: 77,
        execPath: EXECUTABLE,
      },
      -20_000,
    );
    const inspector = createProcessInspector({
      77: { liveness: "alive", executablePath: EXECUTABLE },
      42: { liveness: "alive", executablePath: EXECUTABLE },
    });
    const options = leaseOptions(fixture, clock, inspector);

    await expect(
      inspectWorkspaceLock(
        inspectOptions(fixture, clock, inspector),
      ),
    ).resolves.toMatchObject({
      classification: "ambiguous",
      reason: "heartbeat-stale",
      lockId: "hung-owner",
    });
    await expect(WorkspaceLease.acquire(options)).rejects.toBeInstanceOf(
      WorkspaceLockConflictError,
    );
    await expect(
      WorkspaceLease.acquire({
        ...options,
        force: { expectedLockId: "some-other-owner" },
      }),
    ).rejects.toBeInstanceOf(WorkspaceLockExpectedOwnerError);

    const lease = await WorkspaceLease.acquire({
      ...options,
      force: { expectedLockId: "hung-owner" },
    });
    try {
      expect(lease.metadata.lockId).not.toBe("hung-owner");
    } finally {
      await lease.release();
    }
  });

  it("treats a live legacy owner conservatively and a dead legacy owner as auto-healable", async () => {
    const fixture = await createFixture();
    const clock = createClock();
    await mkdir(join(fixture.root, "state"), { recursive: true });
    await writeFile(fixture.lockPath, "77\n", { mode: 0o600 });
    await utimes(
      fixture.lockPath,
      new Date(clock.now()),
      new Date(clock.now()),
    );
    const aliveInspector = createProcessInspector({
      77: { liveness: "alive", executablePath: EXECUTABLE },
      42: { liveness: "alive", executablePath: EXECUTABLE },
    });
    const inspection = await inspectWorkspaceLock(
      inspectOptions(fixture, clock, aliveInspector),
    );
    expect(inspection).toMatchObject({
      classification: "ambiguous",
      reason: "legacy-owner-live",
    });
    expect(inspection.lockId).toMatch(/^legacy:/);

    const deadInspector = createProcessInspector({
      77: { liveness: "dead" },
      42: { liveness: "alive", executablePath: EXECUTABLE },
    });
    const lease = await WorkspaceLease.acquire(
      leaseOptions(fixture, clock, deadInspector),
    );
    await lease.release();
  });

  it("does not remove an incomplete lock during the initialization grace period", async () => {
    const fixture = await createFixture();
    const clock = createClock();
    await mkdir(join(fixture.root, "state"), { recursive: true });
    await writeFile(fixture.lockPath, "", { mode: 0o600 });
    await utimes(
      fixture.lockPath,
      new Date(clock.now()),
      new Date(clock.now()),
    );
    const inspector = createProcessInspector({});
    const inspection = await inspectWorkspaceLock(
      inspectOptions(fixture, clock, inspector),
    );
    expect(inspection).toMatchObject({
      classification: "initializing",
      reason: "metadata-incomplete",
    });
    await expect(
      WorkspaceLease.acquire(
        leaseOptions(fixture, clock, inspector),
      ),
    ).rejects.toBeInstanceOf(WorkspaceLockConflictError);
    expect(await access(fixture.lockPath)).toBeUndefined();
  });

  it("does not auto-heal an unknown future lock version", async () => {
    const fixture = await createFixture();
    const clock = createClock();
    await mkdir(join(fixture.root, "state"), { recursive: true });
    await writeFile(
      fixture.lockPath,
      `${JSON.stringify({
        version: 2,
        lockId: "future-owner",
        pid: 77,
      })}\n`,
      { mode: 0o600 },
    );
    const oldHeartbeat = new Date(clock.now() - 30_000);
    await utimes(fixture.lockPath, oldHeartbeat, oldHeartbeat);
    const inspector = createProcessInspector({
      77: { liveness: "alive", executablePath: EXECUTABLE },
    });

    await expect(
      inspectWorkspaceLock(
        inspectOptions(fixture, clock, inspector),
      ),
    ).resolves.toMatchObject({
      classification: "ambiguous",
      reason: "metadata-version-unknown",
      lockId: "future-owner",
    });
    await expect(
      WorkspaceLease.acquire(
        leaseOptions(fixture, clock, inspector),
      ),
    ).rejects.toBeInstanceOf(WorkspaceLockConflictError);
  });

  it("serializes concurrent acquisitions so only one lease wins", async () => {
    const fixture = await createFixture();
    const clock = createClock();
    const inspector = createProcessInspector({
      42: { liveness: "alive", executablePath: EXECUTABLE },
    });
    const options = leaseOptions(fixture, clock, inspector);

    const results = await Promise.allSettled(
      Array.from({ length: 16 }, () => WorkspaceLease.acquire(options)),
    );
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<WorkspaceLease> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(15);
    expect(
      rejected.every(
        (result) => result.reason instanceof WorkspaceLockConflictError,
      ),
    ).toBe(true);
    await fulfilled[0]?.value.release();
  });

  it("detects fencing, invokes onLost once, and never removes a replacement lock", async () => {
    const fixture = await createFixture();
    const clock = createClock();
    const inspector = createProcessInspector({
      42: { liveness: "alive", executablePath: EXECUTABLE },
    });
    const losses: WorkspaceLeaseLostError[] = [];
    const lease = await WorkspaceLease.acquire({
      ...leaseOptions(fixture, clock, inspector),
      onLost: (error) => {
        losses.push(error);
      },
    });

    await unlink(fixture.lockPath);
    await writeV1Lock(fixture, clock, {
      lockId: "replacement-owner",
      pid: 77,
      execPath: EXECUTABLE,
    });

    await expect(lease.assertOwned()).rejects.toBeInstanceOf(
      WorkspaceLeaseLostError,
    );
    await expect(lease.assertOwned()).rejects.toBeInstanceOf(
      WorkspaceLeaseLostError,
    );
    expect(losses).toHaveLength(1);
    await expect(Promise.all([lease.release(), lease.release()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(
      (JSON.parse(
        await readFile(fixture.lockPath, "utf8"),
      ) as WorkspaceLockMetadataV1).lockId,
    ).toBe("replacement-owner");
  });
});

async function createFixture(): Promise<{
  root: string;
  workspacePath: string;
  lockPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "constelix-workspace-lock-"));
  roots.push(root);
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  return {
    root,
    workspacePath: await realpath(workspacePath),
    lockPath: join(root, "state", "agent.lock"),
  };
}

function createClock(initial = START_TIME): {
  now(): number;
  advance(milliseconds: number): void;
} {
  let current = initial;
  return {
    now: () => current,
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}

function createProcessInspector(
  processes: Record<
    number,
    {
      liveness: "alive" | "dead" | "unknown";
      executablePath?: string;
    }
  >,
): ProcessInspector {
  return {
    liveness: async (pid) => processes[pid]?.liveness ?? "dead",
    executablePath: async (pid) => processes[pid]?.executablePath,
  };
}

function leaseOptions(
  fixture: {
    workspacePath: string;
    lockPath: string;
  },
  clock: { now(): number },
  processInspector: ProcessInspector,
): WorkspaceLockOptions {
  return {
    lockPath: fixture.lockPath,
    workspaceId: "workspace-test",
    workspacePath: fixture.workspacePath,
    agentVersion: "v0.0.5",
    pid: 42,
    execPath: EXECUTABLE,
    bootTimestamp: "2026-07-25T21:59:59.000Z",
    heartbeatIntervalMs: 60_000,
    dependencies: {
      now: clock.now,
      processInspector,
    },
  };
}

function inspectOptions(
  fixture: {
    workspacePath: string;
    lockPath: string;
  },
  clock: { now(): number },
  processInspector: ProcessInspector,
) {
  return {
    lockPath: fixture.lockPath,
    workspaceId: "workspace-test",
    workspacePath: fixture.workspacePath,
    dependencies: {
      now: clock.now,
      processInspector,
    },
  };
}

async function writeV1Lock(
  fixture: {
    root: string;
    workspacePath: string;
    lockPath: string;
  },
  clock: { now(): number },
  owner: {
    lockId: string;
    pid: number;
    execPath: string;
  },
  heartbeatOffsetMs = 0,
): Promise<void> {
  await mkdir(join(fixture.root, "state"), { recursive: true });
  const metadata: WorkspaceLockMetadataV1 = {
    version: 1,
    lockId: owner.lockId,
    pid: owner.pid,
    bootTimestamp: "2026-07-25T21:59:59.000Z",
    execPath: owner.execPath,
    agentVersion: "v0.0.4",
    workspaceId: "workspace-test",
    workspacePath: fixture.workspacePath,
    createdAt: "2026-07-25T21:59:59.000Z",
  };
  await writeFile(fixture.lockPath, `${JSON.stringify(metadata)}\n`, {
    mode: 0o600,
  });
  const heartbeat = new Date(clock.now() + heartbeatOffsetMs);
  await utimes(fixture.lockPath, heartbeat, heartbeat);
}
