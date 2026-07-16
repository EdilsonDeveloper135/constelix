import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileConflictError,
  contentHash,
  readWorkspaceTextFile,
  writeWorkspaceTextFile,
} from "./files.js";

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
});
