import {
  chmod,
  mkdtemp,
  mkdir,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PathSecurityError,
  WorkspaceIdentityError,
  WorkspaceReadOnlyError,
  assertWorkspaceIdentity,
  assertWorkspaceWritable,
  canonicalizeWorkspace,
  containsClearlySecretContent,
  createSafeChildEnvironment,
  inspectWorkspace,
  isSensitiveCredentialPath,
  normalizeRelativePath,
  redactLocalPaths,
  redactSecrets,
  resolveExistingWorkspacePath,
  resolveWritableWorkspacePath,
  summarizeWorkspacePath,
} from "./security.js";

describe("workspace path security", () => {
  it("canonicalizes a directory and accepts contained files", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix café workspace-"));
    await mkdir(join(root, "src con espacios"));
    await writeFile(
      join(root, "src con espacios", "módulo.ts"),
      "export const ok = true;\n",
    );
    const canonical = await canonicalizeWorkspace(root);
    await expect(
      resolveExistingWorkspacePath(canonical, "src con espacios/módulo.ts"),
    ).resolves.toBe(join(canonical, "src con espacios", "módulo.ts"));
  });

  it("describes canonical aliases with one stable 24-character workspace id", async () => {
    const parent = await mkdtemp(join(tmpdir(), "constelix-descriptor-"));
    const root = join(parent, "workspace");
    const alias = join(parent, "workspace-alias");
    await mkdir(root);
    await symlink(root, alias);

    const direct = await inspectWorkspace(root);
    const linked = await inspectWorkspace(alias);
    const canonicalRoot = await realpath(root);

    expect(direct.canonicalRoot).toBe(canonicalRoot);
    expect(linked.canonicalRoot).toBe(canonicalRoot);
    expect(direct.workspaceId).toMatch(/^[a-f0-9]{24}$/);
    expect(linked.workspaceId).toBe(direct.workspaceId);
    expect(direct.mode).toBe("edit");
    expect(direct.readOnly).toBe(false);
    expect(direct.identity.dev).toBeGreaterThan(0);
    expect(direct.identity.ino).toBeGreaterThan(0);
  });

  it("supports an explicit read-only mode and blocks write gates", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-read-only-"));
    const descriptor = await inspectWorkspace(root, { forceReadOnly: true });

    expect(descriptor).toMatchObject({ mode: "read", readOnly: true });
    expect(() => assertWorkspaceWritable(descriptor)).toThrow(
      WorkspaceReadOnlyError,
    );
    await expect(
      resolveWritableWorkspacePath(descriptor, "new.ts"),
    ).rejects.toBeInstanceOf(WorkspaceReadOnlyError);
  });

  it("detects a replaced workspace root by device and inode", async () => {
    const parent = await mkdtemp(join(tmpdir(), "constelix-identity-"));
    const root = join(parent, "workspace");
    await mkdir(root);
    const descriptor = await inspectWorkspace(root);

    await rename(root, join(parent, "workspace-original"));
    await mkdir(root);

    await expect(assertWorkspaceIdentity(descriptor)).rejects.toBeInstanceOf(
      WorkspaceIdentityError,
    );
    await expect(
      resolveExistingWorkspacePath(descriptor, "."),
    ).rejects.toBeInstanceOf(WorkspaceIdentityError);
  });

  it("detects a filesystem-enforced read-only directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-permissions-"));
    await chmod(root, 0o555);
    try {
      const descriptor = await inspectWorkspace(root);
      expect(descriptor).toMatchObject({ mode: "read", readOnly: true });
    } finally {
      await chmod(root, 0o755);
    }
  });

  it("rejects absolute paths and traversal", () => {
    expect(() => normalizeRelativePath("../secret")).toThrow(PathSecurityError);
    expect(() => normalizeRelativePath("/etc/passwd")).toThrow(PathSecurityError);
    expect(() => normalizeRelativePath("src/../../secret")).toThrow(PathSecurityError);
    expect(() => normalizeRelativePath("src/\0secret")).toThrow(PathSecurityError);
  });

  it("rejects symlinks escaping the workspace for reads and writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "constelix-root-"));
    const outside = await mkdtemp(join(tmpdir(), "constelix-outside-"));
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(root, "escape"));
    await expect(resolveExistingWorkspacePath(root, "escape/secret.txt")).rejects.toThrow(
      PathSecurityError,
    );
    await expect(resolveWritableWorkspacePath(root, "escape/new.txt")).rejects.toThrow(
      PathSecurityError,
    );
  });

  it("summarizes workspace paths and redacts local roots without exposing home", () => {
    const home = "/Users/developer";
    const root = `${home}/Projects/private-project`;
    expect(summarizeWorkspacePath(root, home)).toBe("~/…/private-project");
    expect(
      redactLocalPaths(
        `Failed at ${root}/src/main.ts under ${home}/Library`,
        root,
        home,
      ),
    ).toBe("Failed at <workspace>/src/main.ts under ~/Library");
  });

  it("redacts equivalent macOS private path aliases", () => {
    expect(
      redactLocalPaths(
        "Failed at /var/folders/example/workspace/src/main.ts",
        "/private/var/folders/example/workspace",
        "/Users/developer",
      ),
    ).toBe("Failed at <workspace>/src/main.ts");
    expect(
      redactLocalPaths(
        "Failed at /tmp/workspace/src/main.ts",
        "/private/tmp/workspace",
        "/Users/developer",
      ),
    ).toBe("Failed at <workspace>/src/main.ts");
  });
});

describe("secret handling", () => {
  it("blocks common package-manager, cloud and local credential paths", () => {
    for (const path of [
      ".npmrc",
      ".netrc",
      ".pypirc",
      ".aws/credentials",
      ".aws/config",
      ".config/gcloud/application_default_credentials.json",
      ".config/gh/hosts.yml",
      ".config/pypoetry/auth.toml",
      ".kube/config",
      ".docker/config.json",
      ".terraform.d/credentials.tfrc.json",
      "infra/terraform.tfstate",
      "config/client_secret_prod.json",
    ]) {
      expect(isSensitiveCredentialPath(path), path).toBe(true);
    }
    expect(isSensitiveCredentialPath("src/config.ts")).toBe(false);
    expect(isSensitiveCredentialPath("docs/example.env.md")).toBe(false);
  });

  it("detects clear credential content but permits placeholders", () => {
    expect(containsClearlySecretContent("AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP")).toBe(true);
    expect(containsClearlySecretContent("api_key=real-production-secret-12345")).toBe(true);
    expect(containsClearlySecretContent("aws_secret_access_key=very-long-production-secret-value")).toBe(true);
    expect(containsClearlySecretContent("-----BEGIN PRIVATE KEY-----\nmaterial")).toBe(true);
    expect(containsClearlySecretContent("api_key=${OPENAI_API_KEY}")).toBe(false);
    expect(containsClearlySecretContent("password=changeme")).toBe(false);
    expect(containsClearlySecretContent("const token = process.env.ACCESS_TOKEN")).toBe(false);
  });

  it("redacts credentials and builds an allowlisted child environment", () => {
    expect(redactSecrets("token=abc123 password=hunter2 sk-abcdefghijklmnop")).not.toContain(
      "hunter2",
    );
    const child = createSafeChildEnvironment({
      HOME: "/tmp/home",
      PATH: "/usr/bin",
      OPENAI_API_KEY: "must-not-leak",
      AWS_SECRET_ACCESS_KEY: "must-not-leak",
    });
    expect(child).toEqual({ HOME: "/tmp/home", PATH: "/usr/bin" });
  });
});
