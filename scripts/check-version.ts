import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const root = process.cwd();
const version = (await readFile(resolve(root, "VERSION"), "utf8")).trim();
const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
if (!match) {
  throw new Error(`VERSION must use vMAJOR.MINOR.PATCH; received ${JSON.stringify(version)}.`);
}

const packageVersion = version.slice(1);
const packagePaths = [
  "package.json",
  "apps/agent/package.json",
  "apps/web/package.json",
  "packages/analyzers/package.json",
  "packages/contracts/package.json",
  "packages/graph-core/package.json",
] as const;

for (const packagePath of packagePaths) {
  const source = await readFile(resolve(root, packagePath), "utf8");
  const manifest = JSON.parse(source) as { version?: unknown };
  if (manifest.version !== packageVersion) {
    throw new Error(
      `${packagePath} must use version ${packageVersion}; received ${JSON.stringify(manifest.version)}.`,
    );
  }
}

const [versioning, changelog, knownIssues, readme, codexSource] = await Promise.all([
  readFile(resolve(root, "VERSIONING.md"), "utf8"),
  readFile(resolve(root, "CHANGELOG.md"), "utf8"),
  readFile(resolve(root, "KNOWN_ISSUES.md"), "utf8"),
  readFile(resolve(root, "README.md"), "utf8"),
  readFile(resolve(root, "apps/agent/src/codex.ts"), "utf8"),
]);

if (!versioning.includes(`## 5. Versión actual\n\n\`${version}\``)) {
  throw new Error(`VERSIONING.md does not declare ${version} as the current version.`);
}
if (!changelog.includes(`## [${version}] - `)) {
  throw new Error(`CHANGELOG.md does not contain an entry for ${version}.`);
}
if (!knownIssues.includes(`Actualizado para \`${version}\``)) {
  throw new Error(`KNOWN_ISSUES.md is not updated for ${version}.`);
}
if (!readme.includes(`constelix-agent-${packageVersion}.tgz`)) {
  throw new Error(`README.md does not reference the ${packageVersion} CLI tarball.`);
}
if (!codexSource.includes(
  `clientInfo: { name: "constelix", title: "Constelix", version: "${packageVersion}" }`,
)) {
  throw new Error(`Codex clientInfo does not use version ${packageVersion}.`);
}

const [{ stdout: existingTag }, { stdout: head }] = await Promise.all([
  execFileAsync("git", ["tag", "--list", version], { cwd: root }),
  execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root }),
]);
if (existingTag.trim() === version) {
  const { stdout: tagCommit } = await execFileAsync(
    "git",
    ["rev-list", "-n", "1", version],
    { cwd: root },
  );
  if (tagCommit.trim() !== head.trim()) {
    throw new Error(
      `${version} already belongs to commit ${tagCommit.trim()} and cannot be reused.`,
    );
  }
}

process.stdout.write(`Version metadata is consistent: ${version}\n`);
