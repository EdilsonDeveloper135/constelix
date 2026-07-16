import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readTypeScriptResolutionOptions,
  scanWorkspace,
} from "./scanner.js";

describe("TypeScript resolution configuration", () => {
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
          `Workspace scan stopped at the ${Buffer.byteLength(first) + Buffer.byteLength(second)} byte aggregate source-memory limit.`,
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
