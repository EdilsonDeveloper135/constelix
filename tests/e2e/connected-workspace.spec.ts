import {
  cp,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

import {
  createWorkspaceId,
  startAgentServer,
  type RunningAgentServer,
} from "../../apps/agent/src/server";
import { ConstelixDatabase } from "../../apps/agent/src/database";

const capabilityToken = "constelix-e2e-capability";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = resolve(repositoryRoot, "tests/fixtures/sample-workspace");

let server: RunningAgentServer | undefined;
let temporaryDirectory: string | undefined;
let workspaceRoot: string | undefined;

test.describe("workspace connected to the local agent", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "constelix-e2e-"));
    workspaceRoot = join(temporaryDirectory, "sample-workspace");
    await cp(fixtureRoot, workspaceRoot, { recursive: true });
    const databasePath = join(temporaryDirectory, "constelix.sqlite");
    const workspaceId = createWorkspaceId(workspaceRoot);
    const seed = new ConstelixDatabase(databasePath);
    seed.upsertWorkspace(workspaceId, workspaceRoot);
    seed.appendAiMessage(workspaceId, `${workspaceId}:main`, {
      id: "e2e-question",
      role: "user",
      content: "¿Qué conecta el servicio de consultas?",
    });
    seed.appendAiMessage(workspaceId, `${workspaceId}:main`, {
      id: "e2e-answer",
      role: "assistant",
      content: "El servicio conecta contratos, ProjectGraph y la función de respuesta.",
    });
    seed.close();
    server = await startAgentServer({
      workspaceRoot,
      dev: true,
      devOrigin: "http://127.0.0.1:5173",
      port: 4321,
      capabilityToken,
      storageDirectory: join(temporaryDirectory, "state"),
      databasePath,
    });

    await waitForIndex(server);
  });

  test.afterAll(async () => {
    try {
      await server?.close();
    } finally {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  });

  test("hydrates the real graph, opens code, and runs a PTY command", async ({ page }) => {
    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") runtimeErrors.push(message.text());
    });

    const realFileRead = page.waitForResponse(
      (response) => response.url().endsWith("/api/v1/files/read") && response.status() === 200,
    );
    const realPtyCreated = page.waitForResponse(
      (response) => response.url().endsWith("/api/v1/terminals") && response.status() === 201,
    );
    await page.goto(`/#token=${encodeURIComponent(capabilityToken)}`);

    await expect(page).toHaveTitle("Constelix");
    await expect(page).toHaveURL("http://127.0.0.1:5173/");
    await expect(page.getByRole("status").filter({ hasText: "Local · Conectado" })).toBeVisible();
    await expect(page.locator(".workspace-identity strong")).toHaveText("sample-workspace");
    await expect(page.getByTestId("workspace-canvas")).toBeVisible();
    await Promise.all([realFileRead, realPtyCreated]);
    await expect(page.getByLabel("Historial de conversación")).toContainText(
      "¿Qué conecta el servicio de consultas?",
    );
    await expect(page.getByLabel("Historial de conversación")).toContainText(
      "El servicio conecta contratos",
    );

    // The store starts from demo panel resources while bootstrap is in flight. Once both
    // real resources are available, only errors from the connected flow are relevant here.
    runtimeErrors.length = 0;

    const semanticNodes = page.locator(".semantic-node");
    await expect.poll(() => semanticNodes.count()).toBeGreaterThan(5);
    await expect(page.locator('.semantic-node[aria-label="file: index.ts"]')).toBeVisible();
    await expect(page.locator('.semantic-node[aria-label="function: answerProjectQuestion"]')).toBeVisible();

    const openIndexInEditor = page.getByRole("button", {
      name: "Abrir index.ts en editor",
    });
    await openIndexInEditor.focus();
    await openIndexInEditor.press("Enter");
    await expect(page.getByTestId("editor-panel")).toBeVisible();
    await expect(page.locator(".editor-breadcrumbs")).toContainText("src");
    await expect(page.locator(".editor-breadcrumbs")).toContainText("index.ts");
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("export");

    const terminalPanels = page.getByTestId("terminal-panel");
    await expect(terminalPanels).toHaveCount(1);
    const secondPtyCreated = page.waitForResponse(
      (response) => response.url().endsWith("/api/v1/terminals") && response.status() === 201,
    );
    await page.getByRole("button", { name: "Nueva terminal" }).click();
    const secondPtyResponse = await secondPtyCreated;
    const secondPty = (await secondPtyResponse.json()) as { id: string };
    await expect(terminalPanels).toHaveCount(2);

    const terminal = terminalPanels.last();
    await expect(terminal).toBeVisible();
    await expect(terminal).toHaveAttribute("data-dispose-ready", "true");
    const terminalInput = terminal.locator("textarea.xterm-helper-textarea");
    await expect(terminalInput).toBeAttached();
    await expect(terminal).not.toContainText("No se pudo iniciar la PTY local");
    await expect(terminal.locator(".xterm-rows")).toContainText("sample-workspace");
    await terminalInput.focus();
    await terminalInput.pressSequentially("uname -s");
    await terminalInput.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText("Darwin");
    await writeTerminalCommand(page, secondPty.id, "npm run build && npm test\r", "pass 1");
    await expect(terminal.locator(".xterm-rows")).toContainText("pass 1");
    await sendTerminalInput(page, secondPty.id, "exit\r");
    const restartButton = page.getByRole("button", { name: "Reiniciar terminal" });
    await expect(restartButton).toBeVisible();
    const restartedPtyCreated = page.waitForResponse(
      (response) => response.url().endsWith("/api/v1/terminals") && response.status() === 201,
    );
    await restartButton.click();
    const restartedPty = (await (await restartedPtyCreated).json()) as { id: string };
    await writeTerminalCommand(page, restartedPty.id, "uname -s\r", "Darwin");
    await expect(terminal.locator(".xterm-rows")).toContainText("Darwin");
    await sendTerminalInput(
      page,
      restartedPty.id,
      "node -e \"setTimeout(() => console.log('RECOVERED_CHUNK'), 800)\"\r",
    );
    await page.context().setOffline(true);
    await page.waitForTimeout(1_250);
    await page.context().setOffline(false);
    await expect(page.getByRole("status").filter({ hasText: "Local · Conectado" })).toBeVisible({ timeout: 8_000 });
    await expect(terminal.locator(".xterm-rows")).toContainText("RECOVERED_CHUNK", { timeout: 8_000 });

    const anchoredPtyCreated = page.waitForResponse(
      (response) => response.url().endsWith("/api/v1/terminals") && response.status() === 201,
    );
    await page
      .getByRole("group", { name: "directory: src", exact: true })
      .getByRole("button", { name: "Abrir terminal en src", exact: true })
      .dispatchEvent("click");
    const anchoredPty = (await (await anchoredPtyCreated).json()) as { cwd: string };
    expect(anchoredPty.cwd).toBe(await realpath(join(workspaceRoot!, "src")));
    await expect(terminalPanels.first().locator(".xterm-rows")).toContainText("src");

    await page.getByRole("tab", { name: "Actuar" }).click();
    await expect(page.getByRole("tab", { name: "Actuar" })).toHaveAttribute("aria-selected", "true");
    await page.waitForTimeout(650);

    expect(runtimeErrors).toEqual([]);
  });

  test("preserves editor and PTY lifecycle, then resolves an external file conflict", async ({ page }) => {
    if (!workspaceRoot) throw new Error("The temporary E2E workspace was not initialized.");
    let terminalCreates = 0;
    let terminalDeletes = 0;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/v1/terminals" && request.method() === "POST") terminalCreates += 1;
      if (url.pathname.startsWith("/api/v1/terminals/") && request.method() === "DELETE") terminalDeletes += 1;
    });

    await page.goto(`/#token=${encodeURIComponent(capabilityToken)}`);
    await expect(page.getByRole("status").filter({ hasText: "Local · Conectado" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Actuar" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("terminal-panel")).toHaveCount(2);
    await expect(page.locator(".editor-breadcrumbs")).toContainText("index.ts");
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("export");
    await expect(page.locator(".xterm").first()).toBeVisible();
    expect(terminalCreates).toBe(0);

    const editor = page.locator(".monaco-editor");
    await editor.click();
    await page.keyboard.press("Meta+ArrowDown");
    await page.keyboard.insertText("\n// borrador local Constelix");
    await expect(page.getByText("Modificado", { exact: true })).toBeVisible();

    terminalCreates = 0;
    terminalDeletes = 0;
    for (let index = 0; index < 4; index += 1) {
      await page.getByRole("button", { name: "Alejar" }).click();
      await page.waitForTimeout(180);
    }
    await expect(page.getByText("Contenido suspendido a este nivel de zoom").first()).toBeVisible();
    for (let index = 0; index < 4; index += 1) {
      await page.getByRole("button", { name: "Acercar" }).click();
      await page.waitForTimeout(180);
    }
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("borrador local Constelix");
    await expect(page.locator(".xterm").first()).toBeVisible();
    expect(terminalCreates).toBe(0);
    expect(terminalDeletes).toBe(0);

    const indexPath = join(workspaceRoot, "src/index.ts");
    const initialDiskContent = await readFile(indexPath, "utf8");
    await writeFile(indexPath, `${initialDiskContent}\n// cambio externo uno\n`);
    await page.getByRole("button", { name: "Guardar archivo" }).click();
    await expect(page.locator(".editor-conflict")).toContainText("Tu borrador sigue intacto");
    await page.getByRole("button", { name: "Recargar disco" }).click();
    await expect(page.locator(".editor-conflict")).toHaveCount(0);
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("cambio externo uno");

    await editor.click();
    await page.keyboard.press("Meta+ArrowDown");
    await page.keyboard.insertText(
      "\nexport function e2eGraphSignal(): boolean { return true; }\n// versión local definitiva",
    );
    const secondDiskContent = await readFile(indexPath, "utf8");
    await writeFile(indexPath, `${secondDiskContent}\n// cambio externo dos\n`);
    await page.getByRole("button", { name: "Guardar archivo" }).click();
    await expect(page.locator(".editor-conflict")).toContainText("Tu borrador sigue intacto");
    await page.getByRole("button", { name: "Sobrescribir" }).click();
    await expect(page.locator(".editor-conflict")).toHaveCount(0);
    await expect.poll(async () => readFile(indexPath, "utf8")).toContain("versión local definitiva");
    await expect.poll(async () => readFile(indexPath, "utf8")).not.toContain("cambio externo dos");
    await expect(
      page.locator('.semantic-node[aria-label="function: e2eGraphSignal"]'),
    ).toBeVisible({ timeout: 3_000 });
  });
});

async function waitForIndex(runningServer: RunningAgentServer): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await runningServer.app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: {
        host: `127.0.0.1:${runningServer.port}`,
        authorization: `Bearer ${capabilityToken}`,
      },
    });
    const payload = response.json() as { index?: { phase?: string } };
    if (response.statusCode === 200 && payload.index?.phase === "ready") return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }

  throw new Error("The local agent did not finish indexing the E2E fixture.");
}

async function writeTerminalCommand(
  page: Page,
  terminalId: string,
  data: string,
  expectedOutput: string,
): Promise<void> {
  await page.evaluate(
    ({ capabilityToken: token, terminalId: id, data: command, expectedOutput: expected }) =>
      new Promise<void>((resolveCommand, rejectCommand) => {
        const socket = new WebSocket(`ws://${window.location.host}/api/v1/events`);
        let output = "";
        const timeout = window.setTimeout(() => {
          socket.close();
          rejectCommand(new Error("PTY output timed out."));
        }, 5_000);

        socket.addEventListener("open", () => {
          socket.send(JSON.stringify({ protocolVersion: 1, type: "authenticate", token }));
        });
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data)) as {
            type?: string;
            payload?: {
              terminalId?: string;
              data?: string;
            };
          };
          if (message.type === "authenticated") {
            socket.send(JSON.stringify({
              protocolVersion: 1,
              type: "terminal.input",
              terminalId: id,
              data: command,
            }));
          }
          if (
            message.type === "terminal.output" &&
            message.payload?.terminalId === id &&
            message.payload.data
          ) {
            output += message.payload.data;
            if (output.includes(expected)) {
              window.clearTimeout(timeout);
              socket.close();
              resolveCommand();
            }
          }
        });
        socket.addEventListener("error", () => {
          window.clearTimeout(timeout);
          rejectCommand(new Error("PTY WebSocket failed."));
        });
      }),
    { capabilityToken, terminalId, data, expectedOutput },
  );
}

async function sendTerminalInput(
  page: Page,
  terminalId: string,
  data: string,
): Promise<void> {
  await page.evaluate(
    ({ capabilityToken: token, terminalId: id, data: command }) =>
      new Promise<void>((resolveCommand, rejectCommand) => {
        const socket = new WebSocket(`ws://${window.location.host}/api/v1/events`);
        const timeout = window.setTimeout(() => {
          socket.close();
          rejectCommand(new Error("PTY input timed out."));
        }, 5_000);
        socket.addEventListener("open", () => {
          socket.send(JSON.stringify({ protocolVersion: 1, type: "authenticate", token }));
        });
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data)) as { type?: string };
          if (message.type !== "authenticated") return;
          socket.send(JSON.stringify({
            protocolVersion: 1,
            type: "terminal.input",
            terminalId: id,
            data: command,
          }));
          window.clearTimeout(timeout);
          socket.close();
          resolveCommand();
        });
        socket.addEventListener("error", () => {
          window.clearTimeout(timeout);
          rejectCommand(new Error("PTY WebSocket failed."));
        });
      }),
    { capabilityToken, terminalId, data },
  );
}
