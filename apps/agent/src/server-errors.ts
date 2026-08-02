import { randomUUID } from "node:crypto";

import type { WorkspaceLockConflict } from "@constelix/contracts";
import { ZodError } from "zod";

import { OpenAIUnavailableError } from "./ask.js";
import { CodexUnavailableError } from "./codex.js";
import {
  FileChangedDuringReadError,
  FileConflictError,
  FileTooLargeError,
  InvalidTextFileError,
} from "./files.js";
import { LlmConfigurationError } from "./llm-config.js";
import {
  LspProtocolError,
  LspSessionLimitError,
  LspUnavailableError,
} from "./lsp.js";
import {
  PathSecurityError,
  WorkspaceIdentityError,
  WorkspaceReadOnlyError,
  WorkspaceValidationError,
  redactSecrets,
  summarizeWorkspacePath,
} from "./security.js";
import { ReadOnlyTerminalUnavailableError } from "./terminals.js";
import { WorkspaceBrowserError } from "./workspace-browser.js";
import {
  RecentWorkspaceNotFoundError,
  WorkspaceOpenLockConflictError,
  WorkspaceSessionChangedError,
  WorkspaceSwitchInProgressError,
} from "./workspace-manager.js";
import {
  WorkspaceLeaseLostError,
  WorkspaceLockExpectedOwnerError,
  WorkspaceLockGuardTimeoutError,
} from "./workspace-lock.js";

export interface MappedAgentError {
  status: number;
  code: string;
  message: string;
  recoverable: boolean;
  details?: unknown;
}

export function mapAgentError(error: Error): MappedAgentError {
  if (error instanceof ZodError) {
    return {
      status: 400,
      code: "INVALID_REQUEST",
      message: "La solicitud no superó la validación.",
      recoverable: true,
    };
  }
  if (error instanceof FileConflictError) {
    return recoverable(error, 409);
  }
  if (error instanceof FileTooLargeError) {
    return recoverable(error, 413);
  }
  if (error instanceof InvalidTextFileError) {
    return recoverable(error, 422);
  }
  if (error instanceof FileChangedDuringReadError) {
    return recoverable(error, 409);
  }
  if (error instanceof PathSecurityError) {
    return fixed(error, 403, false);
  }
  if (error instanceof WorkspaceReadOnlyError) {
    return recoverable(error, 403);
  }
  if (error instanceof WorkspaceIdentityError) {
    return fixed(error, 409, false);
  }
  if (error instanceof WorkspaceOpenLockConflictError) {
    return {
      ...recoverable(error, 409),
      details: toPublicLockConflict(error),
    };
  }
  if (error instanceof WorkspaceSessionChangedError) {
    return {
      ...recoverable(error, 409),
      details: { activeSession: error.activeSession },
    };
  }
  if (
    error instanceof WorkspaceSwitchInProgressError ||
    error instanceof WorkspaceLockExpectedOwnerError
  ) {
    return recoverable(error, 409);
  }
  if (
    error instanceof WorkspaceLockGuardTimeoutError ||
    error instanceof WorkspaceLeaseLostError
  ) {
    return fixed(error, 409, false);
  }
  if (error instanceof RecentWorkspaceNotFoundError) {
    return recoverable(error, 404);
  }
  if (error instanceof WorkspaceBrowserError) {
    const status =
      error.code === "WORKSPACE_PATH_NOT_FOUND"
        ? 404
        : error.code === "WORKSPACE_PATH_UNREADABLE"
          ? 403
          : error.code === "WORKSPACE_BROWSE_TOO_LARGE"
            ? 413
            : 400;
    return fixed(error, status, error.recoverable);
  }
  if (error instanceof WorkspaceValidationError) {
    return fixed(error, error.code === "WORKSPACE_NOT_FOUND" ? 404 : 403, false);
  }
  if (error instanceof LlmConfigurationError) {
    return recoverable(error, 400);
  }
  if (
    error instanceof OpenAIUnavailableError ||
    error instanceof CodexUnavailableError ||
    error instanceof LspUnavailableError ||
    error instanceof ReadOnlyTerminalUnavailableError
  ) {
    return recoverable(error, 503);
  }
  if (
    error instanceof LspSessionLimitError ||
    error instanceof LspProtocolError
  ) {
    return recoverable(error, 409);
  }
  const nodeError = error as NodeJS.ErrnoException;
  if (nodeError.code === "ENOENT") {
    return {
      status: 404,
      code: "NOT_FOUND",
      message: "No se encontró el recurso solicitado.",
      recoverable: true,
    };
  }
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: redactSecrets(error.message || "Error interno del agente."),
    recoverable: true,
  };
}

function recoverable(error: Error & { code: string }, status: number): MappedAgentError {
  return fixed(error, status, true);
}

function fixed(
  error: Error & { code: string },
  status: number,
  isRecoverable: boolean,
): MappedAgentError {
  return {
    status,
    code: error.code,
    message: error.message,
    recoverable: isRecoverable,
  };
}

function toPublicLockConflict(
  error: WorkspaceOpenLockConflictError,
): WorkspaceLockConflict {
  const { inspection } = error;
  const metadata = inspection.metadata;
  const isVersionOne = metadata?.version === 1;
  const forceAllowed =
    inspection.classification === "ambiguous" &&
    inspection.lockId !== undefined;
  return {
    conflictId: randomUUID(),
    lockId: inspection.lockId ?? randomUUID(),
    workspaceId: error.workspaceId,
    displayPath: summarizeWorkspacePath(error.workspacePath),
    status: inspection.classification === "active" ? "active" : "ambiguous",
    forceAllowed,
    ...(metadata && metadata.pid > 0 ? { pid: metadata.pid } : {}),
    ...(isVersionOne ? { agentVersion: metadata.agentVersion } : {}),
    ...(inspection.heartbeatAt
      ? { heartbeatAt: inspection.heartbeatAt }
      : {}),
  };
}
