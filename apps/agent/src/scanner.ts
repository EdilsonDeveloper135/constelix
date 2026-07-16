import { createHash } from "node:crypto";
import { opendir, readFile, realpath, stat } from "node:fs/promises";
import { posix, relative, resolve, sep } from "node:path";
import createIgnore, { type Ignore } from "ignore";
import type { TypeScriptResolutionOptions } from "@constelix/analyzers";
import { resolveExistingWorkspacePath } from "./security.js";

export const MAX_WORKSPACE_FILES = 10_000;
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_TYPESCRIPT_CONFIG_BYTES = 1024 * 1024;

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

const SECRET_FILE_PATTERNS = [
  /(?:^|\/)\.env(?:\..+)?$/i,
  /(?:^|\/)(?:credentials|secrets?)(?:\.[^/]*)?$/i,
  /\.(?:pem|key|p12|pfx|jks)$/i,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/i,
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
}

export async function buildIgnoreMatcher(workspaceRoot: string): Promise<Ignore> {
  const matcher = createIgnore().add(DEFAULT_IGNORES);
  for (const name of [".gitignore", ".constelixignore"]) {
    try {
      const path = await resolveExistingWorkspacePath(workspaceRoot, name);
      matcher.add(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return matcher;
}

export async function readTypeScriptResolutionOptions(
  workspaceRoot: string,
): Promise<TypeScriptResolutionOptions | undefined> {
  for (const configName of ["tsconfig.json", "jsconfig.json"]) {
    try {
      const configPath = await resolveExistingWorkspacePath(workspaceRoot, configName);
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
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(relativePath));
}

export async function scanWorkspace(
  workspaceId: string,
  workspaceRoot: string,
  options: { maxFiles?: number; maxBytes?: number } = {},
): Promise<ScanResult> {
  const maxFiles = Math.min(Math.max(options.maxFiles ?? MAX_WORKSPACE_FILES, 1), MAX_WORKSPACE_FILES);
  const maxBytes = Math.min(Math.max(options.maxBytes ?? MAX_SOURCE_BYTES, 1), MAX_SOURCE_BYTES);
  const matcher = await buildIgnoreMatcher(workspaceRoot);
  const result: ScanResult = { files: [], skipped: 0, truncated: false, diagnostics: [] };
  const visitedDirectories = new Set<string>();

  async function walk(absoluteDirectory: string, relativeDirectory = ""): Promise<void> {
    if (result.truncated) return;
    const canonicalDirectory = await realpath(absoluteDirectory);
    if (visitedDirectories.has(canonicalDirectory)) return;
    visitedDirectories.add(canonicalDirectory);

    const directory = await opendir(absoluteDirectory);
    for await (const entry of directory) {
      if (result.files.length >= maxFiles) {
        result.truncated = true;
        result.diagnostics.push({ message: `Workspace scan stopped at the ${maxFiles} file limit.` });
        break;
      }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const ignoreCandidate = entry.isDirectory() ? `${relativePath}/` : relativePath;
      if (matcher.ignores(ignoreCandidate) || isSecretPath(relativePath)) {
        result.skipped += 1;
        continue;
      }

      const absolutePath = resolve(absoluteDirectory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        try {
          const target = await resolveExistingWorkspacePath(workspaceRoot, relativePath);
          const targetStats = await stat(target);
          if (targetStats.isDirectory()) await walk(target, relativePath);
          else if (targetStats.isFile()) await addFile(target, relativePath);
        } catch {
          result.skipped += 1;
          result.diagnostics.push({ relativePath, message: "Symlink outside the workspace was skipped." });
        }
        continue;
      }
      if (entry.isFile()) await addFile(absolutePath, relativePath);
    }
  }

  async function addFile(absolutePath: string, relativePath: string): Promise<void> {
    const language = detectSupportedLanguage(relativePath);
    if (!language) {
      result.skipped += 1;
      return;
    }
    const info = await stat(absolutePath);
    if (info.size > maxBytes) {
      result.skipped += 1;
      result.diagnostics.push({ relativePath, message: `File exceeds the ${maxBytes} byte source limit.` });
      return;
    }
    const buffer = await readFile(absolutePath);
    if (buffer.includes(0)) {
      result.skipped += 1;
      result.diagnostics.push({ relativePath, message: "Binary file was skipped." });
      return;
    }
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
  }

  await walk(workspaceRoot);
  result.files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return result;
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
