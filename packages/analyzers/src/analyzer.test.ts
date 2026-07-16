import { describe, expect, it } from "vitest";
import { analyzeFiles, analyzeSource, detectLanguage } from "./index.js";

describe("language detection", () => {
  it("recognizes every MVP source extension", () => {
    expect(detectLanguage("view.tsx")).toBe("tsx");
    expect(detectLanguage("service.mjs")).toBe("javascript");
    expect(detectLanguage("worker.py")).toBe("python");
    expect(detectLanguage("README.md")).toBe("unknown");
  });
});

describe("Tree-sitter analysis", () => {
  it("extracts TypeScript symbols and semantic relations", () => {
    const result = analyzeSource({
      workspaceId: "fixture",
      relativePath: "src/service.ts",
      source: `
        import { db } from "./db";
        export interface Service extends Disposable { run(): void }
        export class UserService extends BaseService implements Service {
          run() { helper(); db.save(); }
        }
        export function helper() { return true; }
      `
    });

    const kinds = new Set(result.snapshot.nodes.map((node) => node.kind));
    const relations = new Set(result.snapshot.edges.map((edge) => edge.relation));
    expect(kinds).toEqual(expect.objectContaining(new Set(["file", "module", "interface", "class", "method", "function", "external"])));
    expect(relations).toEqual(expect.objectContaining(new Set(["contains", "imports", "exports", "extends", "implements", "calls"])));
    expect(result.snapshot.edges.find((edge) => edge.relation === "calls" && edge.confidence === "resolved")).toBeDefined();
  });

  it("extracts Python classes, methods and calls while tolerating syntax errors", () => {
    const result = analyzeSource({
      workspaceId: "fixture",
      relativePath: "pkg/service.py",
      source: `
from .base import Base
class Service(Base):
    def run(self):
        helper(

def helper():
    return 1
      `
    });

    expect(result.snapshot.nodes.some((node) => node.kind === "class" && node.name === "Service")).toBe(true);
    expect(result.snapshot.nodes.some((node) => node.kind === "method" && node.name === "run")).toBe(true);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("builds project folders and resolves relative imports across files", () => {
    const result = analyzeFiles([
      { relativePath: "src/api.ts", source: `import { service } from "./service"; export const api = () => service();` },
      { relativePath: "src/service.ts", source: `export function service() { return 1; }` }
    ], { workspaceId: "fixture", projectName: "demo", revision: 3 });

    expect(result.snapshot.nodes.some((node) => node.kind === "project" && node.name === "demo")).toBe(true);
    expect(result.snapshot.nodes.some((node) => node.kind === "folder" && node.relativePath === "src")).toBe(true);
    const importEdge = result.snapshot.edges.find((edge) => edge.relation === "imports");
    expect(importEdge?.confidence).toBe("resolved");
    expect(result.snapshot.nodes.find((node) => node.id === importEdge?.target)?.kind).toBe("module");
  });

  it("resolves Python package-relative imports", () => {
    const result = analyzeFiles([
      { relativePath: "pkg/api.py", source: "from .service import service\ndef api():\n    return service()\n" },
      { relativePath: "pkg/service.py", source: "def service():\n    return 1\n" }
    ], { workspaceId: "fixture", projectName: "demo" });

    const importEdge = result.snapshot.edges.find((edge) => edge.relation === "imports");
    expect(importEdge?.confidence).toBe("resolved");
    expect(result.snapshot.nodes.find((node) => node.id === importEdge?.target)?.qualifiedName).toBe("pkg.service");
  });

  it("extracts every module in a Python multi-import", () => {
    const result = analyzeFiles([
      { relativePath: "pkg/api.py", source: "import pkg.one, pkg.two as two\n" },
      { relativePath: "pkg/one.py", source: "" },
      { relativePath: "pkg/two.py", source: "" }
    ], { workspaceId: "fixture" });

    const imported = result.snapshot.edges
      .filter((edge) => edge.relation === "imports")
      .map((edge) => result.snapshot.nodes.find((node) => node.id === edge.target)?.qualifiedName)
      .sort();
    expect(imported).toEqual(["pkg.one", "pkg.two"]);
  });

  it("produces stable IDs across repeated analysis", () => {
    const input = { workspaceId: "fixture", relativePath: "src/a.ts", source: "export function a() {}" };
    const first = analyzeSource(input);
    const second = analyzeSource({ ...input, revision: 2 });
    expect(first.snapshot.nodes.map((node) => node.id)).toEqual(second.snapshot.nodes.map((node) => node.id));
    expect(first.snapshot.edges.map((edge) => edge.id)).toEqual(second.snapshot.edges.map((edge) => edge.id));
  });
});
