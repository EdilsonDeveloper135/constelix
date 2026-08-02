import { execFile } from "node:child_process";

import {
  WorkspaceFolderPickResponseSchema,
  type WorkspaceFolderPickResponse,
} from "@constelix/contracts";

type FolderPickerRunner = (
  executable: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: FolderPickerRunner = (executable, args) =>
  new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });

export async function chooseNativeWorkspaceFolder(
  platform = process.platform,
  run: FolderPickerRunner = defaultRunner,
): Promise<WorkspaceFolderPickResponse> {
  if (platform !== "darwin") {
    return WorkspaceFolderPickResponseSchema.parse({
      protocolVersion: 1,
      status: "unavailable",
      message: "El selector nativo está disponible actualmente en macOS.",
    });
  }

  try {
    const { stdout } = await run("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "Selecciona un workspace para Constelix")',
    ]);
    const path = stdout.trim().replace(/\/$/u, "");
    if (!path.startsWith("/") || path.length > 8_192) {
      throw new Error("El selector devolvió una ruta no válida.");
    }
    return WorkspaceFolderPickResponseSchema.parse({
      protocolVersion: 1,
      status: "selected",
      path,
    });
  } catch (error) {
    const detail = `${error instanceof Error ? error.message : ""} ${
      typeof error === "object" && error && "stderr" in error
        ? String(error.stderr)
        : ""
    }`;
    if (/cancel|canceled|-128/iu.test(detail)) {
      return WorkspaceFolderPickResponseSchema.parse({
        protocolVersion: 1,
        status: "cancelled",
      });
    }
    return WorkspaceFolderPickResponseSchema.parse({
      protocolVersion: 1,
      status: "unavailable",
      message: "No se pudo abrir el selector de carpetas de macOS.",
    });
  }
}
