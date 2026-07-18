import { describe, expect, it } from "vitest";
import { formatWorkspaceLaunchLine, parseArgs } from "./cli.js";

describe("Constelix CLI", () => {
  it("parses a workspace and local development flags", () => {
    expect(
      parseArgs([
        "/tmp/workspace",
        "--dev",
        "--no-open",
        "--read-only",
        "--port",
        "0",
      ]),
    ).toEqual({
      path: "/tmp/workspace",
      dev: true,
      openBrowser: false,
      readOnly: true,
      port: 0,
    });
    expect(parseArgs(["--", "--dev", "--no-open"])).toMatchObject({
      dev: true,
      openBrowser: false,
      readOnly: false,
    });
  });

  it("rejects unknown flags and multiple roots", () => {
    expect(() => parseArgs(["--unknown"])).toThrow("Unknown option");
    expect(() => parseArgs(["one", "two"])).toThrow("single workspace");
  });

  it("summarizes the workspace without exposing its absolute path", () => {
    const canonicalRoot = "/Users/developer/Projects/private-workspace";
    const output = formatWorkspaceLaunchLine(
      canonicalRoot,
      true,
      "/Users/developer",
    );

    expect(output).toBe(
      "Constelix is running for ~/…/private-workspace (Modo Lectura)",
    );
    expect(output).not.toContain(canonicalRoot);
  });
});
