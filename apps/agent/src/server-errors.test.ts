import { describe, expect, it } from "vitest";
import { ZodError, z } from "zod";

import {
  FileChangedDuringWriteError,
  NotAFileError,
} from "./files.js";
import { TerminalSessionLimitError } from "./terminals.js";
import { mapAgentError } from "./server-errors.js";

describe("mapAgentError", () => {
  it("maps a directory opened as a text file to a recoverable 400, not a crash-shaped 500", () => {
    expect(mapAgentError(new NotAFileError())).toMatchObject({
      status: 400,
      code: "NOT_A_FILE",
      recoverable: true,
    });
  });

  it("maps a write-time target change to the same recoverable 409 as a read-time change", () => {
    expect(mapAgentError(new FileChangedDuringWriteError())).toMatchObject({
      status: 409,
      code: "FILE_CHANGED_DURING_WRITE",
      recoverable: true,
    });
  });

  it("maps the concurrent terminal session limit to a recoverable 409", () => {
    expect(mapAgentError(new TerminalSessionLimitError())).toMatchObject({
      status: 409,
      code: "TERMINAL_SESSION_LIMIT",
      recoverable: true,
    });
  });

  it("still maps schema validation failures to 400 and unknown errors to a redacted 500", () => {
    let zodError: ZodError;
    try {
      z.object({ protocolVersion: z.literal(1) }).parse({});
      throw new Error("expected parse to fail");
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      zodError = error;
    }
    expect(mapAgentError(zodError)).toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
    });

    expect(mapAgentError(new Error("unexpected internal failure"))).toEqual({
      status: 500,
      code: "INTERNAL_ERROR",
      message: "unexpected internal failure",
      recoverable: true,
    });
  });
});
