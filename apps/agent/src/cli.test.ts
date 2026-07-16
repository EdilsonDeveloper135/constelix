import { describe, expect, it } from "vitest";
import { parseArgs } from "./cli.js";

describe("Constelix CLI", () => {
  it("parses a workspace and local development flags", () => {
    expect(parseArgs(["/tmp/workspace", "--dev", "--no-open", "--port", "0"])).toEqual({
      path: "/tmp/workspace",
      dev: true,
      openBrowser: false,
      port: 0,
    });
    expect(parseArgs(["--", "--dev", "--no-open"])).toMatchObject({
      dev: true,
      openBrowser: false,
    });
  });

  it("rejects unknown flags and multiple roots", () => {
    expect(() => parseArgs(["--unknown"])).toThrow("Unknown option");
    expect(() => parseArgs(["one", "two"])).toThrow("single workspace");
  });
});
