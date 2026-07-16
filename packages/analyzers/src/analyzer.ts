import { opendir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import Python from "tree-sitter-python";
import TypeScript from "tree-sitter-typescript";
import {
  GraphSnapshotSchema,
  PROTOCOL_VERSION,
  redactSensitiveText,
  type GraphConfidence,
  type GraphEdge,
  type GraphEvidence,
  type GraphNode,
  type GraphNodeKind,
  type GraphRelation,
  type GraphSnapshot,
  type Language,
  type SourceRange
} from "@constelix/contracts";
import { analysisEdgeId, analysisNodeId, analyzerStableId } from "./ids.js";

const SUPPORTED_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".py",
  ".pyi",
]);
const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor"
]);

export interface AnalyzerDiagnostic {
  code: "parse_error" | "missing_syntax" | "unsupported_language" | "read_error" | "file_limit" | "file_too_large";
  severity: "warning" | "error";
  message: string;
  relativePath: string;
  range?: SourceRange;
}

export interface SourceFileInput {
  relativePath: string;
  source: string;
  language?: Language;
}

export interface AnalyzeSourceInput extends SourceFileInput {
  workspaceId: string;
  revision?: number;
}

export interface AnalyzeFilesOptions {
  workspaceId: string;
  revision?: number;
  projectName?: string;
  typeScriptResolution?: TypeScriptResolutionOptions;
}

export interface TypeScriptResolutionOptions {
  baseUrl: string;
  paths: Record<string, readonly string[]>;
}

export interface AnalyzeWorkspaceOptions {
  workspaceId?: string;
  revision?: number;
  projectName?: string;
  maxFiles?: number;
  maxFileBytes?: number;
  excludedDirectories?: readonly string[];
}

export interface AnalysisResult {
  snapshot: GraphSnapshot;
  diagnostics: AnalyzerDiagnostic[];
}

interface ParseContext {
  workspaceId: string;
  revision: number;
  relativePath: string;
  language: Language;
  moduleNode: GraphNode;
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  symbolsByName: Map<string, GraphNode[]>;
  pendingRelations: PendingRelation[];
  pendingExports: Array<{ name: string; evidence: GraphEvidence }>;
}

interface OwnerContext {
  id: string;
  qualifiedName: string;
  kind: GraphNodeKind;
}

interface PendingRelation {
  source: string;
  relation: Exclude<GraphRelation, "contains" | "exports">;
  targetName: string;
  evidence: GraphEvidence;
  role: "import" | "base" | "call";
  confidence?: GraphConfidence;
}

export function detectLanguage(relativePath: string): Language {
  const lower = relativePath.toLocaleLowerCase();
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) {
    return "typescript";
  }
  if (lower.endsWith(".jsx")) return "jsx";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".py") || lower.endsWith(".pyi")) return "python";
  return "unknown";
}

export function analyzeSource(input: AnalyzeSourceInput): AnalysisResult {
  const relativePath = normalizeRelativePath(input.relativePath);
  const language = input.language ?? detectLanguage(relativePath);
  const revision = input.revision ?? 1;
  const diagnostics: AnalyzerDiagnostic[] = [];
  const fileNode = makeNode({
    workspaceId: input.workspaceId,
    revision,
    kind: "file",
    name: path.posix.basename(relativePath),
    qualifiedName: relativePath,
    relativePath,
    language,
    metadata: { extension: path.posix.extname(relativePath) }
  });
  const moduleName = moduleNameForPath(relativePath, language);
  const moduleNode = makeNode({
    workspaceId: input.workspaceId,
    revision,
    kind: "module",
    name: moduleName.split(".").at(-1) ?? moduleName,
    qualifiedName: moduleName,
    relativePath,
    language,
    metadata: {}
  });
  const nodes = new Map<string, GraphNode>([[fileNode.id, fileNode], [moduleNode.id, moduleNode]]);
  const edges = new Map<string, GraphEdge>();
  addEdge(edges, fileNode.id, moduleNode.id, "contains", "extracted", [], revision);

  if (language === "unknown") {
    diagnostics.push({
      code: "unsupported_language",
      severity: "warning",
      message: `No parser is available for ${relativePath}`,
      relativePath
    });
    return {
      snapshot: GraphSnapshotSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        workspaceId: input.workspaceId,
        revision,
        nodes: [...nodes.values()],
        edges: [...edges.values()],
        truncated: false
      }),
      diagnostics
    };
  }

  const parser = new Parser();
  parser.setLanguage(grammarFor(language));
  let tree: Parser.Tree;
  try {
    tree = parser.parse(input.source);
  } catch (error) {
    diagnostics.push({
      code: "parse_error",
      severity: "error",
      message: error instanceof Error ? error.message : "Tree-sitter could not parse this source",
      relativePath
    });
    return {
      snapshot: GraphSnapshotSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        workspaceId: input.workspaceId,
        revision,
        nodes: [...nodes.values()],
        edges: [...edges.values()],
        truncated: false
      }),
      diagnostics
    };
  }

  collectSyntaxDiagnostics(tree.rootNode, relativePath, diagnostics);
  const context: ParseContext = {
    workspaceId: input.workspaceId,
    revision,
    relativePath,
    language,
    moduleNode,
    nodes,
    edges,
    symbolsByName: new Map(),
    pendingRelations: [],
    pendingExports: []
  };
  visitNode(tree.rootNode, { id: moduleNode.id, qualifiedName: moduleName, kind: "module" }, context);
  resolvePendingRelations(context);
  resolvePendingExports(context);

  return {
    snapshot: GraphSnapshotSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      workspaceId: input.workspaceId,
      revision,
      nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
      edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
      truncated: false
    }),
    diagnostics
  };
}

export function analyzeFiles(files: readonly SourceFileInput[], options: AnalyzeFilesOptions): AnalysisResult {
  const revision = options.revision ?? 1;
  const diagnostics: AnalyzerDiagnostic[] = [];
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const projectName = options.projectName ?? options.workspaceId;
  const projectNode = makeNode({
    workspaceId: options.workspaceId,
    revision,
    kind: "project",
    name: projectName,
    qualifiedName: projectName,
    relativePath: "",
    language: "unknown",
    metadata: {}
  });
  nodes.set(projectNode.id, projectNode);

  const orderedFiles = [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  for (const file of orderedFiles) {
    const result = analyzeSource({
      ...file,
      workspaceId: options.workspaceId,
      revision
    });
    diagnostics.push(...result.diagnostics);
    for (const node of result.snapshot.nodes) nodes.set(node.id, node);
    for (const edge of result.snapshot.edges) mergeEdge(edges, edge);
    const relativePath = normalizeRelativePath(file.relativePath);
    const fileNode = result.snapshot.nodes.find((node) => node.kind === "file");
    if (fileNode === undefined) continue;
    const parentId = ensureFolders(relativePath, projectNode, nodes, edges, options.workspaceId, revision);
    addEdge(edges, parentId, fileNode.id, "contains", "extracted", [], revision);
  }

  resolveCrossFileRelations(
    nodes,
    edges,
    options.workspaceId,
    revision,
    options.typeScriptResolution,
  );
  removeUnreferencedExternalNodes(nodes, edges);
  return {
    snapshot: GraphSnapshotSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      workspaceId: options.workspaceId,
      revision,
      nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
      edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
      truncated: false
    }),
    diagnostics
  };
}

export async function analyzeWorkspace(rootPath: string, options: AnalyzeWorkspaceOptions = {}): Promise<AnalysisResult> {
  const root = await realpath(rootPath);
  const workspaceId = options.workspaceId ?? analyzerStableId("workspace", root);
  const maxFiles = options.maxFiles ?? 10_000;
  const maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
  const exclusions = new Set([...DEFAULT_EXCLUDED_DIRECTORIES, ...(options.excludedDirectories ?? [])]);
  const inputs: SourceFileInput[] = [];
  const diagnostics: AnalyzerDiagnostic[] = [];

  async function scan(directory: string): Promise<void> {
    const handle = await opendir(directory);
    const entries = [];
    for await (const entry of handle) entries.push(entry);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (inputs.length >= maxFiles) return;
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!exclusions.has(entry.name)) await scan(absolutePath);
        continue;
      }
      if (!entry.isFile() || !SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLocaleLowerCase())) continue;
      const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
      try {
        const fileStat = await stat(absolutePath);
        if (fileStat.size > maxFileBytes) {
          diagnostics.push({
            code: "file_too_large",
            severity: "warning",
            message: `Skipped ${relativePath}: ${fileStat.size} bytes exceeds the configured limit`,
            relativePath
          });
          continue;
        }
        inputs.push({ relativePath, source: await readFile(absolutePath, "utf8") });
      } catch (error) {
        diagnostics.push({
          code: "read_error",
          severity: "warning",
          message: error instanceof Error ? error.message : `Could not read ${relativePath}`,
          relativePath
        });
      }
    }
  }

  await scan(root);
  if (inputs.length >= maxFiles) {
    diagnostics.push({
      code: "file_limit",
      severity: "warning",
      message: `Analysis stopped at the configured limit of ${maxFiles} files`,
      relativePath: ""
    });
  }
  const result = analyzeFiles(inputs, {
    workspaceId,
    revision: options.revision ?? 1,
    projectName: options.projectName ?? path.basename(root)
  });
  return { snapshot: result.snapshot, diagnostics: [...diagnostics, ...result.diagnostics] };
}

function grammarFor(language: Language): unknown {
  if (language === "typescript") return TypeScript.typescript;
  if (language === "tsx") return TypeScript.tsx;
  if (language === "python") return Python;
  return JavaScript;
}

function visitNode(node: Parser.SyntaxNode, owner: OwnerContext, context: ParseContext): void {
  for (const importSpecifier of importSpecifiersFor(node, context.language)) {
    context.pendingRelations.push({
      source: context.moduleNode.id,
      relation: "imports",
      targetName: importSpecifier,
      evidence: evidenceFor(node, context.relativePath),
      role: "import",
      confidence: "extracted"
    });
  }

  if (isBareExportNode(node, context.language)) {
    for (const name of exportedNames(node)) {
      context.pendingExports.push({ name, evidence: evidenceFor(node, context.relativePath) });
    }
  }

  const definition = definitionFor(node, owner, context.language);
  let childOwner = owner;
  if (definition !== undefined) {
    const qualifiedName = `${owner.qualifiedName}.${definition.name}`;
    const symbol = makeNode({
      workspaceId: context.workspaceId,
      revision: context.revision,
      kind: definition.kind,
      name: definition.name,
      qualifiedName,
      relativePath: context.relativePath,
      language: context.language,
      range: rangeFor(node),
      metadata: { signature: redactSensitiveText(compactText(node.text, 240)) }
    });
    context.nodes.set(symbol.id, symbol);
    const named = context.symbolsByName.get(symbol.name) ?? [];
    named.push(symbol);
    context.symbolsByName.set(symbol.name, named);
    addEdge(
      context.edges,
      owner.id,
      symbol.id,
      "contains",
      "extracted",
      [evidenceFor(node, context.relativePath)],
      context.revision
    );
    if (isExportedDefinition(node, context.language, owner.kind, definition.name)) {
      addEdge(
        context.edges,
        context.moduleNode.id,
        symbol.id,
        "exports",
        "extracted",
        [evidenceFor(node, context.relativePath)],
        context.revision
      );
    }
    for (const base of baseRelationsFor(node, definition.kind, context.language)) {
      context.pendingRelations.push({
        source: symbol.id,
        relation: base.relation,
        targetName: base.name,
        evidence: evidenceFor(base.node, context.relativePath),
        role: "base"
      });
    }
    childOwner = { id: symbol.id, qualifiedName, kind: definition.kind };
  }

  if (isCallNode(node, context.language)) {
    const callee = callTarget(node, context.language);
    if (callee !== undefined && callee !== "require") {
      context.pendingRelations.push({
        source: ownerForCall(definition, owner, childOwner).id,
        relation: "calls",
        targetName: callee,
        evidence: evidenceFor(node, context.relativePath),
        role: "call"
      });
    }
  }

  for (const child of node.namedChildren) visitNode(child, childOwner, context);
}

function definitionFor(
  node: Parser.SyntaxNode,
  owner: OwnerContext,
  language: Language
): { name: string; kind: GraphNodeKind } | undefined {
  let kind: GraphNodeKind | undefined;
  if (node.type === "class_declaration" || node.type === "abstract_class_declaration" || node.type === "class_definition") {
    kind = "class";
  } else if (node.type === "interface_declaration") {
    kind = "interface";
  } else if (["method_definition", "method_signature", "abstract_method_signature"].includes(node.type)) {
    kind = "method";
  } else if (["function_declaration", "generator_function_declaration", "function_signature"].includes(node.type)) {
    kind = owner.kind === "class" || owner.kind === "interface" ? "method" : "function";
  } else if (language === "python" && node.type === "function_definition") {
    kind = owner.kind === "class" ? "method" : "function";
  } else if (node.type === "variable_declarator") {
    const value = node.childForFieldName("value");
    if (value !== null && ["arrow_function", "function_expression", "generator_function"].includes(value.type)) kind = "function";
  }
  if (kind === undefined) return undefined;
  const nameNode = node.childForFieldName("name");
  const name = nameNode?.text.trim();
  if (name === undefined || name.length === 0 || !/^[#$A-Za-z_\p{L}][\w$#\p{L}\p{N}]*$/u.test(name)) return undefined;
  return { name, kind };
}

function baseRelationsFor(
  node: Parser.SyntaxNode,
  kind: GraphNodeKind,
  language: Language
): Array<{ relation: "extends" | "implements"; name: string; node: Parser.SyntaxNode }> {
  const relations: Array<{ relation: "extends" | "implements"; name: string; node: Parser.SyntaxNode }> = [];
  if (language === "python" && kind === "class") {
    const superclasses = node.childForFieldName("superclasses");
    if (superclasses !== null) {
      for (const child of superclasses.namedChildren) {
        const name = simpleName(child.text);
        if (name !== undefined) relations.push({ relation: "extends", name, node: child });
      }
    }
    return relations;
  }
  for (const child of node.namedChildren) {
    const containers = child.type === "class_heritage" ? child.namedChildren : [child];
    for (const container of containers) {
      const relation = container.type.includes("implements") ? "implements"
        : container.type.includes("extends") || container.type === "class_heritage" ? "extends"
        : undefined;
      if (relation === undefined) continue;
      for (const target of container.namedChildren) {
        const name = simpleName(target.text);
        if (name !== undefined) relations.push({ relation, name, node: target });
      }
    }
  }
  return relations;
}

function resolvePendingRelations(context: ParseContext): void {
  for (const pending of context.pendingRelations) {
    const candidates = context.symbolsByName.get(simpleName(pending.targetName) ?? pending.targetName) ?? [];
    let target: GraphNode;
    let confidence = pending.confidence ?? "ambiguous";
    if (pending.role !== "import" && candidates.length === 1 && candidates[0] !== undefined) {
      target = candidates[0];
      confidence = "inferred";
    } else {
      target = makeExternalNode(context, pending.targetName, pending.role);
      if (pending.role === "import") confidence = pending.confidence ?? "extracted";
      else if (candidates.length > 1) confidence = "ambiguous";
    }
    addEdge(
      context.edges,
      pending.source,
      target.id,
      pending.relation,
      confidence,
      [pending.evidence],
      context.revision,
      { role: pending.role, specifier: pending.targetName }
    );
  }
}

function resolvePendingExports(context: ParseContext): void {
  for (const pending of context.pendingExports) {
    const candidates = context.symbolsByName.get(pending.name) ?? [];
    for (const target of candidates) {
      addEdge(
        context.edges,
        context.moduleNode.id,
        target.id,
        "exports",
        candidates.length === 1 ? "inferred" : "ambiguous",
        [pending.evidence],
        context.revision
      );
    }
  }
}

function makeExternalNode(context: ParseContext, targetName: string, role: PendingRelation["role"]): GraphNode {
  const qualifiedName = targetName.replace(/^['"]|['"]$/g, "");
  const node = makeNode({
    workspaceId: context.workspaceId,
    revision: context.revision,
    kind: "external",
    name: simpleName(qualifiedName) ?? qualifiedName,
    qualifiedName,
    relativePath: "",
    language: "unknown",
    metadata: { role, specifier: qualifiedName, symbolName: simpleName(qualifiedName) ?? qualifiedName }
  });
  context.nodes.set(node.id, node);
  return node;
}

function resolveCrossFileRelations(
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  workspaceId: string,
  revision: number,
  typeScriptResolution?: TypeScriptResolutionOptions,
): void {
  const modules = [...nodes.values()].filter((node) => node.kind === "module");
  const moduleKeys = new Map<string, GraphNode>();
  for (const module of modules) {
    const normalizedPath = normalizeRelativePath(module.relativePath);
    const withoutExtension = normalizedPath.replace(/\.(?:[cm]?[jt]sx?|pyi?)$/i, "");
    moduleKeys.set(normalizedPath, module);
    moduleKeys.set(withoutExtension, module);
    moduleKeys.set(withoutExtension.replace(/\/index$/i, ""), module);
    moduleKeys.set(module.qualifiedName, module);
  }
  const symbolsByName = new Map<string, GraphNode[]>();
  for (const node of nodes.values()) {
    if (!["class", "interface", "function", "method"].includes(node.kind)) continue;
    const list = symbolsByName.get(node.name) ?? [];
    list.push(node);
    symbolsByName.set(node.name, list);
  }

  const replacements: GraphEdge[] = [];
  for (const edge of edges.values()) {
    const target = nodes.get(edge.target);
    if (target?.kind !== "external") continue;
    const specifier = typeof edge.metadata.specifier === "string" ? edge.metadata.specifier : target.qualifiedName;
    let resolved: GraphNode | undefined;
    let confidence: GraphConfidence = edge.confidence;
    if (edge.relation === "imports") {
      const source = nodes.get(edge.source);
      if (source !== undefined) {
        resolved = resolveImportTarget(
          source,
          specifier,
          moduleKeys,
          typeScriptResolution,
        );
      }
      if (resolved !== undefined) confidence = "inferred";
    } else {
      const candidates = symbolsByName.get(simpleName(specifier) ?? specifier) ?? [];
      if (candidates.length === 1) {
        resolved = candidates[0];
        confidence = "inferred";
      } else if (candidates.length > 1) {
        confidence = "ambiguous";
      }
    }
    if (resolved === undefined) continue;
    replacements.push({
      ...edge,
      id: analysisEdgeId(edge.source, edge.relation, resolved.id),
      target: resolved.id,
      confidence,
      revision
    });
  }
  for (const replacement of replacements) {
    for (const [id, edge] of edges) {
      if (edge.source === replacement.source && edge.relation === replacement.relation && edge.target !== replacement.target && edge.id !== replacement.id) {
        const oldTarget = nodes.get(edge.target);
        if (oldTarget?.kind === "external" && edge.metadata.specifier === replacement.metadata.specifier) edges.delete(id);
      }
    }
    mergeEdge(edges, replacement);
  }
  void workspaceId;
}

function resolveImportTarget(
  source: GraphNode,
  specifier: string,
  modules: ReadonlyMap<string, GraphNode>,
  typeScriptResolution?: TypeScriptResolutionOptions,
): GraphNode | undefined {
  if (source.language === "python" && specifier.startsWith(".")) {
    const dotCount = specifier.match(/^\.+/)?.[0].length ?? 1;
    const packageParts = source.qualifiedName.split(".").slice(0, -1);
    const keep = Math.max(0, packageParts.length - (dotCount - 1));
    const suffix = specifier.slice(dotCount).replaceAll("/", ".");
    const qualified = [...packageParts.slice(0, keep), ...suffix.split(".").filter(Boolean)].join(".");
    return findModule(modules, qualified);
  }
  if (specifier.startsWith(".")) {
    const base = path.posix.dirname(source.relativePath);
    const resolved = normalizeRelativePath(path.posix.join(base, specifier));
    return findModule(modules, resolved);
  }
  if (source.language === "python") {
    const normalized = specifier.replace(/^\.+/, "").replaceAll("/", ".");
    return findModule(modules, normalized);
  }
  if (typeScriptResolution !== undefined) {
    for (const [pattern, targets] of Object.entries(typeScriptResolution.paths)) {
      const wildcard = matchPathPattern(pattern, specifier);
      if (wildcard === undefined) continue;
      for (const target of targets) {
        const substituted = target.replaceAll("*", wildcard);
        const candidate = normalizeModuleCandidate(
          path.posix.join(typeScriptResolution.baseUrl, substituted),
        );
        const resolved = findModule(modules, candidate);
        if (resolved !== undefined) return resolved;
      }
    }
    const baseUrlCandidate = normalizeModuleCandidate(
      path.posix.join(typeScriptResolution.baseUrl, specifier),
    );
    const baseUrlResolved = findModule(modules, baseUrlCandidate);
    if (baseUrlResolved !== undefined) return baseUrlResolved;
  }
  return findModule(modules, specifier);
}

function matchPathPattern(pattern: string, specifier: string): string | undefined {
  const wildcardIndex = pattern.indexOf("*");
  if (wildcardIndex === -1) return pattern === specifier ? "" : undefined;
  const prefix = pattern.slice(0, wildcardIndex);
  const suffix = pattern.slice(wildcardIndex + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function normalizeModuleCandidate(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
}

function findModule(
  modules: ReadonlyMap<string, GraphNode>,
  candidate: string,
): GraphNode | undefined {
  const normalized = normalizeModuleCandidate(candidate);
  const withoutExtension = normalized.replace(/\.(?:[cm]?[jt]sx?|pyi?)$/i, "");
  return (
    modules.get(normalized) ??
    modules.get(withoutExtension) ??
    modules.get(withoutExtension.replace(/\/index$/i, ""))
  );
}

function ensureFolders(
  relativeFilePath: string,
  projectNode: GraphNode,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  workspaceId: string,
  revision: number
): string {
  const segments = path.posix.dirname(relativeFilePath).split("/").filter((segment) => segment !== "." && segment.length > 0);
  let currentPath = "";
  let parentId = projectNode.id;
  for (const segment of segments) {
    currentPath = currentPath.length === 0 ? segment : `${currentPath}/${segment}`;
    const folder = makeNode({
      workspaceId,
      revision,
      kind: "folder",
      name: segment,
      qualifiedName: currentPath,
      relativePath: currentPath,
      language: "unknown",
      metadata: {}
    });
    nodes.set(folder.id, folder);
    addEdge(edges, parentId, folder.id, "contains", "extracted", [], revision);
    parentId = folder.id;
  }
  return parentId;
}

function removeUnreferencedExternalNodes(nodes: Map<string, GraphNode>, edges: ReadonlyMap<string, GraphEdge>): void {
  const referenced = new Set<string>();
  for (const edge of edges.values()) {
    referenced.add(edge.source);
    referenced.add(edge.target);
  }
  for (const [id, node] of nodes) if (node.kind === "external" && !referenced.has(id)) nodes.delete(id);
}

function makeNode(input: {
  workspaceId: string;
  revision: number;
  kind: GraphNodeKind;
  name: string;
  qualifiedName: string;
  relativePath: string;
  language: Language;
  range?: SourceRange;
  metadata: Record<string, unknown>;
}): GraphNode {
  return {
    protocolVersion: PROTOCOL_VERSION,
    id: analysisNodeId(input.workspaceId, input.kind, input.relativePath, input.qualifiedName),
    kind: input.kind,
    name: input.name,
    qualifiedName: input.qualifiedName,
    relativePath: input.relativePath,
    ...(input.range === undefined ? {} : { range: input.range }),
    language: input.language,
    revision: input.revision,
    metadata: input.metadata
  };
}

function addEdge(
  edges: Map<string, GraphEdge>,
  source: string,
  target: string,
  relation: GraphRelation,
  confidence: GraphConfidence,
  evidence: GraphEvidence[],
  revision: number,
  metadata: Record<string, unknown> = {}
): void {
  const id = analysisEdgeId(source, relation, target);
  const current = edges.get(id);
  if (current !== undefined) {
    mergeEdge(edges, { ...current, evidence: [...current.evidence, ...evidence] });
    return;
  }
  edges.set(id, {
    protocolVersion: PROTOCOL_VERSION,
    id,
    source,
    target,
    relation,
    confidence,
    evidence,
    revision,
    metadata
  });
}

function mergeEdge(edges: Map<string, GraphEdge>, edge: GraphEdge): void {
  const current = edges.get(edge.id);
  if (current === undefined) {
    edges.set(edge.id, edge);
    return;
  }
  const evidenceKeys = new Set(current.evidence.map((item) => `${item.relativePath}:${item.range.startByte ?? ""}:${item.range.endByte ?? ""}`));
  const evidence = [...current.evidence];
  for (const item of edge.evidence) {
    const key = `${item.relativePath}:${item.range.startByte ?? ""}:${item.range.endByte ?? ""}`;
    if (!evidenceKeys.has(key)) {
      evidenceKeys.add(key);
      evidence.push(item);
    }
  }
  edges.set(edge.id, { ...current, ...edge, evidence });
}

function importSpecifiersFor(node: Parser.SyntaxNode, language: Language): string[] {
  if (language === "python") {
    if (node.type === "import_from_statement") {
      const match = /^from\s+([^\s]+)\s+import\s+/s.exec(node.text);
      return match?.[1] === undefined ? [] : [match[1]];
    }
    if (node.type === "import_statement") {
      const body = /^import\s+(.+)$/s.exec(node.text)?.[1];
      if (body === undefined) return [];
      return body.split(",").map((item) => item.trim().split(/\s+as\s+/)[0]).filter((item): item is string => item !== undefined && item.length > 0);
    }
    return [];
  }
  if (node.type === "import_statement" || node.type === "export_statement") {
    const source = node.childForFieldName("source");
    if (source !== null) return [stripQuotes(source.text)];
  }
  if (node.type === "call_expression" && node.childForFieldName("function")?.text === "require") {
    const argumentsNode = node.childForFieldName("arguments");
    const first = argumentsNode?.namedChildren[0];
    if (first?.type === "string") return [stripQuotes(first.text)];
  }
  return [];
}

function isBareExportNode(node: Parser.SyntaxNode, language: Language): boolean {
  if (language === "python" || node.type !== "export_statement") return false;
  return !node.namedChildren.some((child) => [
    "class_declaration",
    "abstract_class_declaration",
    "function_declaration",
    "generator_function_declaration",
    "lexical_declaration",
    "variable_declaration",
    "interface_declaration"
  ].includes(child.type));
}

function exportedNames(node: Parser.SyntaxNode): string[] {
  const names = new Set<string>();
  for (const child of node.namedChildren) {
    if (["identifier", "shorthand_property_identifier", "export_specifier"].includes(child.type)) {
      const name = child.childForFieldName("name")?.text ?? child.namedChildren[0]?.text ?? child.text;
      const simple = simpleName(name);
      if (simple !== undefined) names.add(simple);
    }
    for (const nested of child.namedChildren) {
      if (nested.type === "export_specifier") {
        const simple = simpleName(nested.childForFieldName("name")?.text ?? nested.namedChildren[0]?.text ?? "");
        if (simple !== undefined) names.add(simple);
      }
    }
  }
  return [...names];
}

function isExportedDefinition(node: Parser.SyntaxNode, language: Language, ownerKind: GraphNodeKind, name: string): boolean {
  if (ownerKind !== "module") return false;
  if (language === "python") return !name.startsWith("_");
  let parent: Parser.SyntaxNode | null = node.parent;
  while (parent !== null && parent.type !== "program") {
    if (parent.type === "export_statement") return true;
    parent = parent.parent;
  }
  return false;
}

function isCallNode(node: Parser.SyntaxNode, language: Language): boolean {
  return language === "python" ? node.type === "call" : node.type === "call_expression";
}

function callTarget(node: Parser.SyntaxNode, language: Language): string | undefined {
  const target = node.childForFieldName("function");
  if (target === null) return undefined;
  if (language === "python" || target.type !== "member_expression") return simpleName(target.text);
  return simpleName(target.childForFieldName("property")?.text ?? target.text);
}

function ownerForCall(
  definition: { name: string; kind: GraphNodeKind } | undefined,
  owner: OwnerContext,
  childOwner: OwnerContext
): OwnerContext {
  return definition === undefined ? owner : childOwner;
}

function collectSyntaxDiagnostics(
  root: Parser.SyntaxNode,
  relativePath: string,
  diagnostics: AnalyzerDiagnostic[]
): void {
  if (!root.hasError) return;
  const stack = [root];
  while (stack.length > 0 && diagnostics.length < 50) {
    const node = stack.pop();
    if (node === undefined) continue;
    if (node.isError || node.isMissing) {
      diagnostics.push({
        code: node.isMissing ? "missing_syntax" : "parse_error",
        severity: "warning",
        message: node.isMissing ? `Missing ${node.type}` : `Could not parse ${compactText(node.text, 80) || node.type}`,
        relativePath,
        range: rangeFor(node)
      });
    }
    stack.push(...node.namedChildren);
  }
  if (diagnostics.length === 0) {
    diagnostics.push({
      code: "parse_error",
      severity: "warning",
      message: "The source contains incomplete or invalid syntax",
      relativePath,
      range: rangeFor(root)
    });
  }
}

function rangeFor(node: Parser.SyntaxNode): SourceRange {
  return {
    start: { line: node.startPosition.row, column: node.startPosition.column },
    end: { line: node.endPosition.row, column: node.endPosition.column },
    startByte: node.startIndex,
    endByte: node.endIndex
  };
}

function evidenceFor(node: Parser.SyntaxNode, relativePath: string): GraphEvidence {
  return {
    relativePath,
    range: rangeFor(node),
    excerpt: redactSensitiveText(compactText(node.text, 300))
  };
}

function moduleNameForPath(relativePath: string, language: Language): string {
  const withoutExtension = relativePath.replace(/\.(?:[cm]?[jt]sx?|pyi?)$/i, "");
  const normalized = withoutExtension.replace(/\/index$/i, "");
  if (language === "python") return normalized.replace(/\/__init__$/i, "").replaceAll("/", ".") || "__root__";
  return normalized || "__root__";
}

function normalizeRelativePath(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized) || normalized.includes("\0")) {
    throw new Error(`Invalid relative source path: ${value}`);
  }
  return normalized;
}

function stripQuotes(value: string): string {
  return value.replace(/^['"`]|['"`]$/g, "");
}

function simpleName(value: string): string | undefined {
  const matches = value.match(/[A-Za-z_$\p{L}][\w$\p{L}\p{N}]*/gu);
  return matches?.at(-1);
}

function compactText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}
