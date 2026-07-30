import { chmod, mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_RECENT_WORKSPACES,
  WorkspaceCatalog,
} from "./workspace-catalog";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

describe("WorkspaceCatalog", () => {
  it("keeps canonical roots private while returning redacted recent entries", async () => {
    const directory = await temporaryDirectory();
    const canonicalDirectory = await realpath(directory);
    const root = join(directory, "Projects", "Project One");
    await mkdir(root, { recursive: true });
    const canonicalRoot = await realpath(root);
    const databasePath = join(directory, "state", "global.sqlite");
    const catalog = new WorkspaceCatalog(databasePath, {
      now: () => new Date("2026-07-25T12:00:00.000Z"),
      userHome: canonicalDirectory,
    });

    const recent = catalog.recordOpenedWorkspace({
      workspaceId: "workspace-one",
      canonicalRoot,
      mode: "edit",
    });

    expect(recent).toEqual({
      workspaceId: "workspace-one",
      name: "Project One",
      displayPath: "~/…/Project One",
      lastOpenedAt: "2026-07-25T12:00:00.000Z",
      mode: "edit",
    });
    expect(catalog.listRecentWorkspaces()).toEqual([recent]);
    expect(JSON.stringify(catalog.listRecentWorkspaces())).not.toContain(
      canonicalRoot,
    );
    expect(catalog.lookupWorkspace("workspace-one")).toEqual({
      ...recent,
      canonicalRoot,
    });

    catalog.close();
    const directoryMode = (await stat(join(directory, "state"))).mode & 0o777;
    const databaseMode = (await stat(databasePath)).mode & 0o777;
    expect(directoryMode).toBe(0o700);
    expect(databaseMode).toBe(0o600);
  });

  it("keeps only the twelve most recent workspaces in deterministic order", async () => {
    const directory = await temporaryDirectory();
    const canonicalDirectory = await realpath(directory);
    let tick = 0;
    const catalog = new WorkspaceCatalog(":memory:", {
      now: () => new Date(Date.UTC(2026, 6, 25, 12, 0, tick++)),
      userHome: canonicalDirectory,
    });

    for (let index = 0; index < MAX_RECENT_WORKSPACES + 3; index += 1) {
      catalog.recordOpenedWorkspace({
        workspaceId: `workspace-${index}`,
        canonicalRoot: join(canonicalDirectory, `project-${index}`),
        mode: index % 2 === 0 ? "edit" : "read",
      });
    }

    const recent = catalog.listRecentWorkspaces();
    expect(recent).toHaveLength(MAX_RECENT_WORKSPACES);
    expect(recent[0]?.workspaceId).toBe("workspace-14");
    expect(recent.at(-1)?.workspaceId).toBe("workspace-3");
    expect(catalog.lookupWorkspace("workspace-0")).toBeUndefined();

    catalog.recordOpenedWorkspace({
      workspaceId: "workspace-7",
      canonicalRoot: join(canonicalDirectory, "project-7"),
      mode: "edit",
      name: "Project Seven",
    });
    expect(catalog.listRecentWorkspaces()[0]).toMatchObject({
      workspaceId: "workspace-7",
      name: "Project Seven",
      mode: "edit",
    });
    expect(catalog.listRecentWorkspaces(2)).toHaveLength(2);
    expect(catalog.listRecentWorkspaces(200)).toHaveLength(
      MAX_RECENT_WORKSPACES,
    );

    catalog.close();
  });

  it("persists recent metadata and supports idempotent close", async () => {
    const directory = await temporaryDirectory();
    const canonicalDirectory = await realpath(directory);
    const databasePath = join(directory, "global.sqlite");
    const root = join(canonicalDirectory, "repos", "persisted");
    const first = new WorkspaceCatalog(databasePath, {
      now: () => new Date("2026-07-25T13:00:00.000Z"),
      userHome: canonicalDirectory,
    });
    first.recordOpenedWorkspace({
      workspaceId: "persisted-id",
      canonicalRoot: root,
      mode: "read",
    });
    first.close();
    expect(() => first.close()).not.toThrow();

    const second = new WorkspaceCatalog(databasePath, {
      userHome: canonicalDirectory,
    });
    expect(second.lookupWorkspace("persisted-id")).toMatchObject({
      workspaceId: "persisted-id",
      canonicalRoot: root,
      displayPath: "~/…/persisted",
      mode: "read",
    });
    second.close();
  });

  it("does not change permissions on a pre-existing parent directory", async () => {
    const directory = await temporaryDirectory();
    await chmod(directory, 0o755);

    const catalog = new WorkspaceCatalog(join(directory, "global.sqlite"));
    catalog.close();

    expect((await stat(directory)).mode & 0o777).toBe(0o755);
    expect((await stat(join(directory, "global.sqlite"))).mode & 0o777).toBe(
      0o600,
    );
  });

  it("rejects non-absolute roots and invalid identifiers", () => {
    const catalog = new WorkspaceCatalog(":memory:");
    expect(() =>
      catalog.recordOpenedWorkspace({
        workspaceId: "workspace",
        canonicalRoot: "relative/project",
        mode: "edit",
      })
    ).toThrow(/absolute path/);
    expect(() => catalog.lookupWorkspace("\0")).toThrow(/workspaceId/);
    catalog.close();
    expect(() => catalog.listRecentWorkspaces()).toThrow(/closed/);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "constelix-catalog-"));
  temporaryDirectories.push(directory);
  return directory;
}
