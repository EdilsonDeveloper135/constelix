import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/analyzer-worker.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  sourcemap: true,
  clean: true,
  outDir: "dist",
  noExternal: [
    "@constelix/analyzers",
    "@constelix/contracts",
    "@constelix/graph-core",
  ],
  external: [
    "better-sqlite3",
    "node-pty",
    "tree-sitter",
    "tree-sitter-javascript",
    "tree-sitter-python",
    "tree-sitter-typescript",
  ],
});
