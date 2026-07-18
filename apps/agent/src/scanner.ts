import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { opendir, readFile, stat } from "node:fs/promises";
import { posix, relative, sep } from "node:path";
import createIgnore, { type Ignore } from "ignore";
import type { TypeScriptResolutionOptions } from "@constelix/analyzers";
import type {
  Language,
  WorkspaceOmittedFile,
  WorkspaceSummary,
  WorkspaceWarning,
} from "@constelix/contracts";
import {
  PathSecurityError,
  isSensitiveCredentialPath,
  resolveExistingWorkspacePath,
  type WorkspaceReference,
} from "./security.js";

export const MAX_WORKSPACE_FILES = 10_000;
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_WORKSPACE_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_CONFIGURABLE_WORKSPACE_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_TYPESCRIPT_CONFIG_BYTES = 1024 * 1024;
const DEFAULT_PROGRESS_EVERY_FILES = 100;
const MAX_REPORTED_OMITTED_FILES = 200;

const DEFAULT_IGNORES = [
  ".git/",
  ".hg/",
  ".svn/",
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".next/",
  ".nuxt/",
  ".turbo/",
  ".cache/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "*.min.js",
  "*.min.css",
  "*.map",
] as const;

export type SupportedLanguage = "typescript" | "javascript" | "python";

export interface ScannedSource {
  workspaceId: string;
  relativePath: string;
  absolutePath: string;
  source: string;
  language: SupportedLanguage;
  sizeBytes: number;
  mtimeMs: number;
  contentHash: string;
}

export interface ScanResult {
  files: ScannedSource[];
  skipped: number;
  truncated: boolean;
  diagnostics: Array<{ relativePath?: string; message: string }>;
  summary: WorkspaceSummary;
}

export interface ScanProgress {
  files: readonly ScannedSource[];
  skipped: number;
  sourceBytes: number;
  truncated: boolean;
  complete: boolean;
  diagnostics: ReadonlyArray<{ relativePath?: string; message: string }>;
  summary: WorkspaceSummary;
}

export interface ScanWorkspaceOptions {
  maxFiles?: number;
  maxBytes?: number;
  maxTotalBytes?: number;
  progressEveryFiles?: number;
  onProgress?: (progress: ScanProgress) => void;
}

export async function buildIgnoreMatcher(
  workspace: WorkspaceReference,
): Promise<Ignore> {
  const matcher = createIgnore();
  for (const name of [".gitignore", ".constelixignore"]) {
    try {
      const path = await resolveExistingWorkspacePath(workspace, name);
      matcher.add(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  // System exclusions are appended last so repository negation rules cannot
  // re-include dependency trees, generated output, or cache directories.
  matcher.add(DEFAULT_IGNORES);
  return matcher;
}

export async function readTypeScriptResolutionOptions(
  workspace: WorkspaceReference,
): Promise<TypeScriptResolutionOptions | undefined> {
  for (const configName of ["tsconfig.json", "jsconfig.json"]) {
    try {
      const configPath = await resolveExistingWorkspacePath(workspace, configName);
      const info = await stat(configPath);
      if (!info.isFile() || info.size > MAX_TYPESCRIPT_CONFIG_BYTES) return undefined;
      const source = await readFile(configPath, "utf8");
      const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(source))) as unknown;
      if (!isRecord(parsed) || !isRecord(parsed.compilerOptions)) return undefined;

      const compilerOptions = parsed.compilerOptions;
      const rawBaseUrl =
        typeof compilerOptions.baseUrl === "string" ? compilerOptions.baseUrl : ".";
      const baseUrl = normalizeResolutionPath(rawBaseUrl);
      if (baseUrl === undefined) return undefined;

      const paths: Record<string, readonly string[]> = {};
      if (isRecord(compilerOptions.paths)) {
        for (const [pattern, rawTargets] of Object.entries(compilerOptions.paths)) {
          if (!Array.isArray(rawTargets) || pattern.length === 0) continue;
          const targets = rawTargets
            .filter((target): target is string => typeof target === "string")
            .map(normalizeResolutionPath)
            .filter((target): target is string => target !== undefined);
          if (targets.length > 0) paths[pattern] = targets;
        }
      }
      return { baseUrl, paths };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }
  return undefined;
}

export function detectSupportedLanguage(path: string): SupportedLanguage | undefined {
  const lower = path.toLocaleLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".mts") || lower.endsWith(".cts")) {
    return "typescript";
  }
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return "javascript";
  }
  if (lower.endsWith(".py") || lower.endsWith(".pyi")) return "python";
  return undefined;
}

export function isSecretPath(relativePath: string): boolean {
  return isSensitiveCredentialPath(relativePath);
}

export async function scanWorkspace(
  workspaceId: string,
  workspace: WorkspaceReference,
  options: ScanWorkspaceOptions = {},
): Promise<ScanResult> {
  const maxFiles = Math.min(Math.max(options.maxFiles ?? MAX_WORKSPACE_FILES, 1), MAX_WORKSPACE_FILES);
  const maxBytes = Math.min(Math.max(options.maxBytes ?? MAX_SOURCE_BYTES, 1), MAX_SOURCE_BYTES);
  const maxTotalBytes = Math.min(
    Math.max(options.maxTotalBytes ?? MAX_WORKSPACE_SOURCE_BYTES, 1),
    MAX_CONFIGURABLE_WORKSPACE_SOURCE_BYTES,
  );
  const progressEveryFiles = Math.max(
    1,
    Math.trunc(options.progressEveryFiles ?? DEFAULT_PROGRESS_EVERY_FILES),
  );
  const matcher = await buildIgnoreMatcher(workspace);
  const summaryState = {
    estimatedFileCount: 0,
    languages: new Set<Language>(),
    projectTypes: await detectProjectTypes(workspace),
    warnings: [] as WorkspaceWarning[],
    omittedFiles: [] as WorkspaceOmittedFile[],
    omittedFileCount: 0,
  };
  const result: ScanResult = {
    files: [],
    skipped: 0,
    truncated: false,
    diagnostics: [],
    summary: createWorkspaceSummary(summaryState, 0),
  };
  const visitedDirectories = new Set<string>();
  let sourceBytes = 0;
  let fileLimitReached = false;
  let sourceBudgetReached = false;

  function publishProgress(complete: boolean): void {
    if (!options.onProgress) return;
    result.summary = createWorkspaceSummary(summaryState, result.files.length);
    options.onProgress({
      files: [...result.files],
      skipped: result.skipped,
      sourceBytes,
      truncated: result.truncated,
      complete,
      diagnostics: [...result.diagnostics],
      summary: result.summary,
    });
  }

  async function walk(relativeDirectory = ""): Promise<void> {
    const canonicalDirectory = await resolveExistingWorkspacePath(
      workspace,
      relativeDirectory || ".",
    );
    if (visitedDirectories.has(canonicalDirectory)) return;
    visitedDirectories.add(canonicalDirectory);

    const directory = await opendir(canonicalDirectory);
    const entries: Dirent[] = [];
    for await (const entry of directory) entries.push(entry);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const ignoreCandidate = entry.isDirectory() ? `${relativePath}/` : relativePath;
      if (matcher.ignores(ignoreCandidate)) {
        result.skipped += 1;
        continue;
      }
      if (isSecretPath(relativePath)) {
        result.skipped += 1;
        recordOmission(relativePath, "secret");
        continue;
      }

      if (entry.isDirectory()) {
        await walk(relativePath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        try {
          const target = await resolveExistingWorkspacePath(workspace, relativePath);
          const targetStats = await stat(target);
          if (targetStats.isDirectory()) await walk(relativePath);
          else if (targetStats.isFile()) await addFile(relativePath);
        } catch (error) {
          if (
            !(error instanceof PathSecurityError) &&
            (error as NodeJS.ErrnoException).code !== "ENOENT"
          ) {
            throw error;
          }
          result.skipped += 1;
          recordOmission(relativePath, "outside_workspace");
          addDiagnostic(relativePath, "Symlink outside the workspace was skipped.");
        }
        continue;
      }
      if (entry.isFile()) await addFile(relativePath);
    }
  }

  async function addFile(relativePath: string): Promise<void> {
    const language = detectSupportedLanguage(relativePath);
    if (!language) {
      result.skipped += 1;
      return;
    }
    summaryState.estimatedFileCount += 1;
    summaryState.languages.add(language);
    if (fileLimitReached || result.files.length >= maxFiles) {
      result.skipped += 1;
      result.truncated = true;
      fileLimitReached = true;
      recordOmission(relativePath, "file_limit");
      addDiagnosticOnce(
        "WORKSPACE_FILE_LIMIT",
        relativePath,
        `Workspace index is limited to ${maxFiles} supported source files.`,
      );
      return;
    }
    if (sourceBudgetReached) {
      result.skipped += 1;
      result.truncated = true;
      recordOmission(relativePath, "source_budget");
      return;
    }
    const absolutePath = await resolveExistingWorkspacePath(
      workspace,
      relativePath,
    );
    const info = await stat(absolutePath);
    if (info.size > maxBytes) {
      result.skipped += 1;
      recordOmission(relativePath, "too_large");
      addDiagnostic(relativePath, `File exceeds the ${maxBytes} byte source limit.`);
      return;
    }
    if (sourceBytes + info.size > maxTotalBytes) {
      truncateForSourceBudget(relativePath);
      return;
    }
    const revalidatedPath = await resolveExistingWorkspacePath(
      workspace,
      relativePath,
    );
    if (revalidatedPath !== absolutePath) {
      throw new Error("The source path changed while it was being scanned.");
    }
    const buffer = await readFile(revalidatedPath);
    if (buffer.byteLength > maxBytes) {
      result.skipped += 1;
      recordOmission(relativePath, "too_large");
      addDiagnostic(relativePath, `File exceeds the ${maxBytes} byte source limit.`);
      return;
    }
    if (sourceBytes + buffer.byteLength > maxTotalBytes) {
      truncateForSourceBudget(relativePath);
      return;
    }
    if (buffer.includes(0)) {
      result.skipped += 1;
      recordOmission(relativePath, "binary");
      addDiagnostic(relativePath, "Binary file was skipped.");
      return;
    }
    sourceBytes += buffer.byteLength;
    result.files.push({
      workspaceId,
      relativePath,
      absolutePath,
      source: buffer.toString("utf8"),
      language,
      sizeBytes: buffer.byteLength,
      mtimeMs: info.mtimeMs,
      contentHash: createHash("sha256").update(buffer).digest("hex"),
    });
    if (
      result.files.length === 1 ||
      result.files.length % progressEveryFiles === 0
    ) {
      publishProgress(false);
    }
  }

  function truncateForSourceBudget(relativePath: string): void {
    result.skipped += 1;
    result.truncated = true;
    sourceBudgetReached = true;
    recordOmission(relativePath, "source_budget");
    addDiagnosticOnce(
      "WORKSPACE_SOURCE_BUDGET",
      relativePath,
      `Workspace index is limited to ${maxTotalBytes} aggregate source bytes.`,
    );
  }

  function addDiagnostic(
    relativePath: string,
    message: string,
    publishWarning = true,
  ): void {
    result.diagnostics.push({ relativePath, message });
    if (publishWarning && summaryState.warnings.length < 200) {
      summaryState.warnings.push({
        code: "SCAN_OMISSION",
        relativePath,
        message,
      });
    }
  }

  function addDiagnosticOnce(
    code: string,
    relativePath: string,
    message: string,
  ): void {
    if (summaryState.warnings.some((warning) => warning.code === code)) return;
    if (summaryState.warnings.length < 200) {
      summaryState.warnings.push({ code, relativePath, message });
    }
    addDiagnostic(relativePath, message, false);
  }

  function recordOmission(
    relativePath: string,
    reason: WorkspaceOmittedFile["reason"],
  ): void {
    summaryState.omittedFileCount += 1;
    if (summaryState.omittedFiles.length < MAX_REPORTED_OMITTED_FILES) {
      summaryState.omittedFiles.push({ relativePath, reason });
    }
  }

  await walk();
  result.files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  result.summary = createWorkspaceSummary(summaryState, result.files.length);
  if (options.onProgress) publishProgress(true);
  return result;
}

function createWorkspaceSummary(
  state: {
    projectTypes: readonly string[];
    languages: ReadonlySet<Language>;
    estimatedFileCount: number;
    warnings: readonly WorkspaceWarning[];
    omittedFiles: readonly WorkspaceOmittedFile[];
    omittedFileCount: number;
  },
  indexedFileCount: number,
): WorkspaceSummary {
  return {
    projectTypes: [...state.projectTypes],
    languages: [...state.languages].sort(),
    estimatedFileCount: state.estimatedFileCount,
    indexedFileCount,
    warnings: [...state.warnings],
    omittedFiles: [...state.omittedFiles],
    omittedFileCount: state.omittedFileCount,
    omittedFilesTruncated: state.omittedFileCount > state.omittedFiles.length,
  };
}

async function detectProjectTypes(
  workspace: WorkspaceReference,
): Promise<string[]> {
  const markers = [
    ["package.json", "Node.js"],
    ["tsconfig.json", "TypeScript"],
    ["jsconfig.json", "JavaScript"],
    ["pnpm-workspace.yaml", "pnpm workspace"],
    ["turbo.json", "Turborepo"],
    ["nx.json", "Nx"],
    ["lerna.json", "Lerna"],
    ["vite.config.ts", "Vite"],
    ["vite.config.js", "Vite"],
    ["next.config.js", "Next.js"],
    ["next.config.mjs", "Next.js"],
    ["pyproject.toml", "Python"],
    ["requirements.txt", "Python"],
    ["setup.py", "Python"],
  ] as const;
  const detected = new Set<string>();
  await Promise.all(markers.map(async ([relativePath, projectType]) => {
    try {
      const path = await resolveExistingWorkspacePath(workspace, relativePath);
      if ((await stat(path)).isFile()) detected.add(projectType);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }));
  return [...detected].sort();
}

export function isPathInside(workspaceRoot: string, candidate: string): boolean {
  const fromRoot = relative(workspaceRoot, candidate);
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !fromRoot.startsWith(sep));
}

function normalizeResolutionPath(value: string): string | undefined {
  if (value.includes("\0") || posix.isAbsolute(value.replaceAll("\\", "/"))) return undefined;
  const normalized = posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalized === "." ? "" : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stripJsonComments(value: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index] ?? "";
    const next = value[index + 1] ?? "";
    if (lineComment) {
      if (current === "\n") {
        lineComment = false;
        result += current;
      } else {
        result += " ";
      }
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        result += "  ";
        index += 1;
      } else {
        result += current === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (inString) {
      result += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      result += current;
    } else if (current === "/" && next === "/") {
      lineComment = true;
      result += "  ";
      index += 1;
    } else if (current === "/" && next === "*") {
      blockComment = true;
      result += "  ";
      index += 1;
    } else {
      result += current;
    }
  }
  return result;
}

function stripTrailingCommas(value: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index] ?? "";
    if (inString) {
      result += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      result += current;
      continue;
    }
    if (current === ",") {
      let lookahead = index + 1;
      while (/\s/.test(value[lookahead] ?? "")) lookahead += 1;
      if (value[lookahead] === "}" || value[lookahead] === "]") continue;
    }
    result += current;
  }
  return result;
}
