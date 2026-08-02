import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_WORKSPACE_SOURCE_BYTES,
  readTypeScriptResolutionOptions,
  scanWorkspace,
} from "./scanner.js";
import {
  WorkspaceIdentityError,
  inspectWorkspace,
} from "./security.js";

describe("TypeScript resolution configuration", () => {
  it("keeps the default aggregate source budget at 2 MiB", () => {
    expect(MAX_WORKSPACE_SOURCE_BYTES).toBe(2 * 1024 * 1024);
  });

  it("reads baseUrl and paths from JSONC tsconfig files", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-tsconfig-"));
    await writeFile(
      join(root, "tsconfig.json"),
      `{
        // Constelix supports the JSONC syntax emitted by TypeScript tooling.
        "compilerOptions": {
          "baseUrl": ".",
          "paths": {
            "@fixture/*": ["src/*",],
          },
        },
      }`,
    );

    await expect(readTypeScriptResolutionOptions(root)).resolves.toEqual({
      baseUrl: "",
      paths: { "@fixture/*": ["src/*"] },
    });
  });

  it("rejects path mappings that escape the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-tsconfig-safe-"));
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@safe/*": ["src/*"],
            "@escape/*": ["../outside/*"],
          },
        },
      }),
    );

    await expect(readTypeScriptResolutionOptions(root)).resolves.toEqual({
      baseUrl: "",
      paths: { "@safe/*": ["src/*"] },
    });
  });
});

describe("workspace scanner", () => {
  it("rejects a descriptor whose canonical root was replaced", async () => {
    const parent = await mkdtemp(join(tmpdir(), "constelix-scan-identity-"));
    const root = join(parent, "workspace");
    await mkdir(root);
    await writeFile(join(root, "index.ts"), "export const safe = true;\n");
    const workspace = await inspectWorkspace(root);
    try {
      await rename(root, join(parent, "workspace-original"));
      await mkdir(root);
      await expect(
        scanWorkspace(workspace.workspaceId, workspace),
      ).rejects.toBeInstanceOf(WorkspaceIdentityError);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("indexes an internal file symlink and skips a symlink that escapes the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-scan-links-"));
    const outside = await mkdtemp(join(tmpdir(), "constelix-scan-outside-"));
    await writeFile(join(root, "source.ts"), "export const internal = true;\n");
    await writeFile(join(outside, "secret.ts"), "export const secret = true;\n");
    await symlink(join(root, "source.ts"), join(root, "alias.ts"));
    await symlink(join(outside, "secret.ts"), join(root, "escape.ts"));

    const result = await scanWorkspace("workspace", root);

    expect(result.files.map((file) => file.relativePath)).toEqual(
      expect.arrayContaining(["alias.ts", "source.ts"]),
    );
    expect(result.files.some((file) => file.relativePath === "escape.ts")).toBe(false);
    expect(result.diagnostics).toContainEqual({
      relativePath: "escape.ts",
      message: "Symlink outside the workspace was skipped.",
    });
  });

  it("bounds aggregate source memory and reports deterministic progressive batches", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-scan-budget-"));
    const first = "export const first = 1;\n";
    const second = "export const second = 2;\n";
    const third = "export const third = 3;\n";
    const progress: Array<{
      paths: string[];
      complete: boolean;
      truncated: boolean;
      sourceBytes: number;
    }> = [];
    try {
      await writeFile(join(root, "a.ts"), first);
      await writeFile(join(root, "b.ts"), second);
      await writeFile(join(root, "c.ts"), third);

      const result = await scanWorkspace("workspace", root, {
        maxTotalBytes: Buffer.byteLength(first) + Buffer.byteLength(second),
        progressEveryFiles: 1,
        onProgress: (update) => {
          progress.push({
            paths: update.files.map((file) => file.relativePath),
            complete: update.complete,
            truncated: update.truncated,
            sourceBytes: update.sourceBytes,
          });
        },
      });

      expect(result.files.map((file) => file.relativePath)).toEqual([
        "a.ts",
        "b.ts",
      ]);
      expect(result.truncated).toBe(true);
      expect(result.diagnostics).toContainEqual({
        relativePath: "c.ts",
        message:
          `Workspace index is limited to ${Buffer.byteLength(first) + Buffer.byteLength(second)} aggregate source bytes.`,
      });
      expect(result.summary).toMatchObject({
        estimatedFileCount: 3,
        indexedFileCount: 2,
        omittedFileCount: 1,
        omittedFiles: [{ relativePath: "c.ts", reason: "source_budget" }],
        languages: ["typescript"],
      });
      expect(progress).toEqual([
        {
          paths: ["a.ts"],
          complete: false,
          truncated: false,
          sourceBytes: Buffer.byteLength(first),
        },
        {
          paths: ["a.ts", "b.ts"],
          complete: false,
          truncated: false,
          sourceBytes: Buffer.byteLength(first) + Buffer.byteLength(second),
        },
        {
          paths: ["a.ts", "b.ts"],
          complete: true,
          truncated: true,
          sourceBytes: Buffer.byteLength(first) + Buffer.byteLength(second),
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips malformed UTF-8 source and reports the omission", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-scan-utf8-"));
    try {
      await writeFile(
        join(root, "invalid.ts"),
        Buffer.from([0x65, 0x78, 0x70, 0x6f, 0x72, 0x74, 0xc3, 0x28]),
      );

      const result = await scanWorkspace("workspace", root);

      expect(result.files).toHaveLength(0);
      expect(result.summary.omittedFiles).toContainEqual({
        relativePath: "invalid.ts",
        reason: "binary",
      });
      expect(result.diagnostics).toContainEqual({
        relativePath: "invalid.ts",
        message: "The text editor accepts only valid UTF-8 files.",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds traversal across unsupported filesystem entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-scan-entries-"));
    try {
      await Promise.all([
        writeFile(join(root, "a.ts"), "export const a = true;\n"),
        writeFile(join(root, "b.ts"), "export const b = true;\n"),
        writeFile(join(root, "c.ts"), "export const c = true;\n"),
      ]);

      const result = await scanWorkspace("workspace", root, {
        maxEntries: 2,
      });

      expect(result.files).toHaveLength(0);
      expect(result.truncated).toBe(true);
      expect(result.diagnostics).toContainEqual({
        relativePath: ".",
        message:
          "Workspace traversal is limited to 2 filesystem entries and 25000 entries per directory.",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects project markers and reports bounded omissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-scan-summary-"));
    try {
      await writeFile(join(root, "package.json"), "{}\n");
      await writeFile(join(root, "tsconfig.json"), "{}\n");
      await writeFile(join(root, "a.ts"), "export const a = true;\n");
      await writeFile(join(root, "b.ts"), "export const b = true;\n");
      await writeFile(join(root, ".env"), "OPENAI_API_KEY=secret\n");

      const result = await scanWorkspace("workspace", root, { maxFiles: 1 });

      expect(result.summary.projectTypes).toEqual(["Node.js", "TypeScript"]);
      expect(result.summary.estimatedFileCount).toBe(2);
      expect(result.summary.indexedFileCount).toBe(1);
      expect(result.summary.omittedFiles).toEqual(expect.arrayContaining([
        { relativePath: ".env", reason: "secret" },
        { relativePath: "b.ts", reason: "file_limit" },
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps default exclusions even when repository ignore files negate them", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-scan-default-ignore-"));
    try {
      await mkdir(join(root, "node_modules"), { recursive: true });
      await mkdir(join(root, "dist"), { recursive: true });
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(
        join(root, ".gitignore"),
        "!node_modules/\n!node_modules/dependency.ts\n",
      );
      await writeFile(
        join(root, ".constelixignore"),
        "!dist/\n!dist/bundle.ts\n",
      );
      await writeFile(
        join(root, "node_modules", "dependency.ts"),
        "export const dependency = true;\n",
      );
      await writeFile(
        join(root, "dist", "bundle.ts"),
        "export const generated = true;\n",
      );
      await writeFile(
        join(root, "src", "main.ts"),
        "export const main = true;\n",
      );

      const result = await scanWorkspace("workspace", root);

      expect(result.files.map((file) => file.relativePath)).toEqual([
        "src/main.ts",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
