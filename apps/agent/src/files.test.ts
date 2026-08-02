import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileConflictError,
  FileTooLargeError,
  InvalidTextFileError,
  MAX_TEXT_FILE_BYTES,
  contentHash,
  readWorkspaceTextFile,
  writeWorkspaceTextFile,
} from "./files.js";
import {
  WorkspaceIdentityError,
  WorkspaceReadOnlyError,
  inspectWorkspace,
} from "./security.js";

describe("workspace text files", () => {
  it("writes atomically and detects optimistic concurrency conflicts", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-files-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "main.ts"), "before\n");
    const opened = await readWorkspaceTextFile(root, "src/main.ts");

    const saved = await writeWorkspaceTextFile(root, {
      relativePath: "src/main.ts",
      content: "after\n",
      expectedContentHash: opened.contentHash,
    });
    expect(saved.contentHash).toBe(contentHash("after\n"));
    expect(await readFile(join(root, "src", "main.ts"), "utf8")).toBe("after\n");

    await expect(
      writeWorkspaceTextFile(root, {
        relativePath: "src/main.ts",
        content: "stale edit\n",
        expectedContentHash: opened.contentHash,
      }),
    ).rejects.toBeInstanceOf(FileConflictError);
  });

  it("rejects binary content", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-binary-"));
    await writeFile(join(root, "binary.ts"), Buffer.from([1, 0, 2]));
    await expect(readWorkspaceTextFile(root, "binary.ts")).rejects.toThrow("Binary");
  });

  it("rejects oversized and malformed UTF-8 files before exposing content", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-invalid-text-"));
    await writeFile(
      join(root, "oversized.ts"),
      Buffer.alloc(MAX_TEXT_FILE_BYTES + 1, 0x61),
    );
    await writeFile(
      join(root, "malformed.ts"),
      Buffer.from([0x65, 0x78, 0x70, 0x6f, 0x72, 0x74, 0xc3, 0x28]),
    );

    await expect(
      readWorkspaceTextFile(root, "oversized.ts"),
    ).rejects.toBeInstanceOf(FileTooLargeError);
    await expect(
      readWorkspaceTextFile(root, "malformed.ts"),
    ).rejects.toBeInstanceOf(InvalidTextFileError);
    await expect(
      writeWorkspaceTextFile(root, {
        relativePath: "oversized.ts",
        content: "safe replacement\n",
      }),
    ).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it("does not restore set-user-ID or set-group-ID bits after an edit", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-files-mode-"));
    const path = join(root, "script.ts");
    await writeFile(path, "export const before = true;\n");
    await chmod(path, 0o6755);
    const opened = await readWorkspaceTextFile(root, "script.ts");

    await writeWorkspaceTextFile(root, {
      relativePath: "script.ts",
      content: "export const after = true;\n",
      expectedContentHash: opened.contentHash,
    });

    expect((await stat(path)).mode & 0o7777).toBe(0o755);
  });

  it("blocks editor writes in read-only mode while preserving reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-files-read-only-"));
    await writeFile(join(root, "main.ts"), "export const before = true;\n");
    const workspace = await inspectWorkspace(root, { forceReadOnly: true });

    await expect(readWorkspaceTextFile(workspace, "main.ts")).resolves.toMatchObject({
      content: "export const before = true;\n",
    });
    await expect(
      writeWorkspaceTextFile(workspace, {
        relativePath: "main.ts",
        content: "export const after = true;\n",
      }),
    ).rejects.toBeInstanceOf(WorkspaceReadOnlyError);
    await expect(readFile(join(root, "main.ts"), "utf8")).resolves.toBe(
      "export const before = true;\n",
    );
  });

  it("stops file access when the canonical workspace identity changes", async () => {
    const parent = await mkdtemp(join(tmpdir(), "constelix-files-identity-"));
    const root = join(parent, "workspace");
    await mkdir(root);
    await writeFile(join(root, "main.ts"), "export const original = true;\n");
    const workspace = await inspectWorkspace(root);

    await rename(root, join(parent, "workspace-original"));
    await mkdir(root);
    await writeFile(join(root, "main.ts"), "export const replacement = true;\n");

    await expect(
      readWorkspaceTextFile(workspace, "main.ts"),
    ).rejects.toBeInstanceOf(WorkspaceIdentityError);
    await expect(
      writeWorkspaceTextFile(workspace, {
        relativePath: "main.ts",
        content: "should not be written\n",
      }),
    ).rejects.toBeInstanceOf(WorkspaceIdentityError);
  });
});
