import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTypeScriptResolutionOptions } from "./scanner.js";

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
