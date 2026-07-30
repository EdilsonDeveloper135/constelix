import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_WORKSPACE_BROWSE_ENTRIES,
  WorkspaceBrowser,
  WorkspaceBrowserError,
} from "./workspace-browser";

const temporaryDirectories: string[] = [];
const cursorSecret = "constelix-browser-test-secret";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

describe("WorkspaceBrowser", () => {
  it("returns only directories with Unicode, spaces, and symlink metadata", async () => {
    const root = await temporaryDirectory();
    const unicodeDirectory = join(root, "Proyecto ñ");
    const spacedDirectory = join(root, "with spaces");
    const hiddenDirectory = join(root, ".hidden");
    await Promise.all([
      mkdir(unicodeDirectory),
      mkdir(spacedDirectory),
      mkdir(hiddenDirectory),
      writeFile(join(root, "secret.txt"), "content that must not be read"),
    ]);
    await symlink(unicodeDirectory, join(root, "linked project"), "dir");
    const browser = new WorkspaceBrowser({ cursorSecret });
    const canonicalRoot = await realpath(root);
    const canonicalUnicodeDirectory = await realpath(unicodeDirectory);

    const page = await browser.browse({ path: root });

    expect(page.path).toBe(canonicalRoot);
    expect(page.entries.map(({ name }) => name)).toEqual([
      "linked project",
      "Proyecto ñ",
      "with spaces",
    ]);
    expect(page.entries.map(({ name }) => name)).not.toContain("secret.txt");
    expect(page.entries.map(({ name }) => name)).not.toContain(".hidden");
    expect(page.entries.find(({ name }) => name === "linked project")).toEqual({
      name: "linked project",
      path: join(canonicalRoot, "linked project"),
      canonicalPath: canonicalUnicodeDirectory,
      symbolicLink: true,
      readable: true,
    });
    expect(
      page.entries.find(({ name }) => name === "Proyecto ñ"),
    ).toMatchObject({
      canonicalPath: canonicalUnicodeDirectory,
      symbolicLink: false,
      readable: true,
    });
  });

  it("supports hidden directories and authenticated opaque pagination", async () => {
    const root = await temporaryDirectory();
    await Promise.all(
      [".hidden", "alpha", "beta", "delta", "gamma"].map((name) =>
        mkdir(join(root, name))
      ),
    );
    const browser = new WorkspaceBrowser({ cursorSecret });

    const first = await browser.browse({
      path: root,
      showHidden: true,
      limit: 2,
    });
    expect(first.entries.map(({ name }) => name)).toEqual([
      ".hidden",
      "alpha",
    ]);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toBeDefined();
    expect(first.nextCursor).not.toContain(root);
    if (!first.nextCursor) throw new Error("Expected the first cursor.");

    const second = await browser.browse({
      path: root,
      showHidden: true,
      limit: 2,
      cursor: first.nextCursor,
    });
    if (!second.nextCursor) throw new Error("Expected the second cursor.");
    const third = await browser.browse({
      path: root,
      showHidden: true,
      limit: 2,
      cursor: second.nextCursor,
    });
    expect([
      ...first.entries,
      ...second.entries,
      ...third.entries,
    ].map(({ name }) => name)).toEqual([
      ".hidden",
      "alpha",
      "beta",
      "delta",
      "gamma",
    ]);
    expect(third.nextCursor).toBeUndefined();
    expect(third.truncated).toBe(false);
  });

  it("resolves a symlinked browse root and exposes its canonical parent", async () => {
    const container = await temporaryDirectory();
    const target = join(container, "target");
    const child = join(target, "child");
    const link = join(container, "target link");
    await mkdir(child, { recursive: true });
    await symlink(target, link, "dir");
    const browser = new WorkspaceBrowser({ cursorSecret });
    const canonicalContainer = await realpath(container);
    const canonicalTarget = await realpath(target);
    const canonicalChild = await realpath(child);

    const page = await browser.browse({ path: link });

    expect(page.path).toBe(canonicalTarget);
    expect(page.parentPath).toBe(canonicalContainer);
    expect(page.entries).toEqual([
      {
        name: "child",
        path: canonicalChild,
        canonicalPath: canonicalChild,
        symbolicLink: false,
        readable: true,
      },
    ]);
  });

  it.each([
    ["relative/path", "WORKSPACE_PATH_INVALID"],
    ["bad\0path", "WORKSPACE_PATH_INVALID"],
  ] as const)("rejects invalid path %s with a typed error", async (path, code) => {
    const browser = new WorkspaceBrowser({ cursorSecret });
    await expect(browser.browse({ path })).rejects.toMatchObject({
      name: "WorkspaceBrowserError",
      code,
      recoverable: true,
    });
  });

  it("returns typed errors for missing paths, files, and invalid limits", async () => {
    const root = await temporaryDirectory();
    const file = join(root, "file.ts");
    await writeFile(file, "export {};");
    const browser = new WorkspaceBrowser({ cursorSecret });

    await expect(
      browser.browse({ path: join(root, "missing") }),
    ).rejects.toMatchObject({ code: "WORKSPACE_PATH_NOT_FOUND" });
    await expect(browser.browse({ path: file })).rejects.toMatchObject({
      code: "WORKSPACE_PATH_NOT_DIRECTORY",
    });
    await expect(
      browser.browse({
        path: root,
        limit: MAX_WORKSPACE_BROWSE_ENTRIES + 1,
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_BROWSE_LIMIT_INVALID" });
  });

  it("rejects tampered cursors and cursors from another browse context", async () => {
    const root = await temporaryDirectory();
    const other = join(root, "other");
    await Promise.all([
      mkdir(join(root, "alpha")),
      mkdir(join(root, "beta")),
      mkdir(other),
    ]);
    const browser = new WorkspaceBrowser({ cursorSecret });
    const first = await browser.browse({ path: root, limit: 1 });
    if (!first.nextCursor) throw new Error("Expected a pagination cursor.");
    const tampered = `${first.nextCursor.slice(0, -1)}x`;

    for (const request of [
      { path: root, limit: 1, cursor: tampered },
      { path: root, showHidden: true, limit: 1, cursor: first.nextCursor },
      { path: other, limit: 1, cursor: first.nextCursor },
    ]) {
      await expect(browser.browse(request)).rejects.toBeInstanceOf(
        WorkspaceBrowserError,
      );
      await expect(browser.browse(request)).rejects.toMatchObject({
        code: "WORKSPACE_BROWSE_CURSOR_INVALID",
      });
    }
  });

  it("invalidates pagination when the directory listing changes", async () => {
    const root = await temporaryDirectory();
    await Promise.all([
      mkdir(join(root, "alpha")),
      mkdir(join(root, "beta")),
    ]);
    const browser = new WorkspaceBrowser({ cursorSecret });
    const first = await browser.browse({ path: root, limit: 1 });
    if (!first.nextCursor) throw new Error("Expected a pagination cursor.");

    await mkdir(join(root, "aardvark"));

    await expect(browser.browse({
      path: root,
      limit: 1,
      cursor: first.nextCursor,
    })).rejects.toMatchObject({
      code: "WORKSPACE_BROWSE_CURSOR_INVALID",
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "constelix-browser-"));
  temporaryDirectories.push(directory);
  return directory;
}
