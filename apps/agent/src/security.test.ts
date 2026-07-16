import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PathSecurityError,
  canonicalizeWorkspace,
  containsClearlySecretContent,
  createSafeChildEnvironment,
  isSensitiveCredentialPath,
  normalizeRelativePath,
  redactSecrets,
  resolveExistingWorkspacePath,
  resolveWritableWorkspacePath,
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
