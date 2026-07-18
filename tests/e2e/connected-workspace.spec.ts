import {
  access,
  cp,
  mkdtemp,
  readFile,
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
const readOnlyFixtureRoot = resolve(
  repositoryRoot,
  "tests/fixtures/v003-typescript-workspace",
);
const webPort = parsePort(process.env.CONSTELIX_E2E_WEB_PORT, 5273);
const agentPort = parsePort(process.env.CONSTELIX_E2E_AGENT_PORT, 4421);
const webOrigin = `http://127.0.0.1:${webPort}`;

let server: RunningAgentServer | undefined;
let temporaryDirectory: string | undefined;
let workspaceRoot: string | undefined;

test.describe.configure({ mode: "serial" });

test.describe("workspace connected to the local agent", () => {
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
      devOrigin: webOrigin,
      port: agentPort,
      capabilityToken,
      storageDirectory: join(temporaryDirectory, "state"),
      databasePath,
      askOptions: { apiKey: "" },
      codexOptions: {
        getCodexVersion: async () => undefined,
      },
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

    const realPtyCreated = page.waitForResponse(
      (response) => response.url().endsWith("/api/v1/terminals") && response.status() === 201,
    );
    await openConnectedWorkspace(page, {
      expectedName: "sample-workspace",
      expectedMode: "Edición",
    });

    await expect(page).toHaveTitle("Constelix");
    await expect(page).toHaveURL(`${webOrigin}/`);
    await expect(page.getByRole("status").filter({ hasText: "Agente local conectado" })).toBeVisible();
    await expect(page.locator(".workspace-identity strong")).toHaveText("sample-workspace");
    await expect(page.getByTestId("workspace-canvas")).toBeVisible();
    await realPtyCreated;
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
    await page.getByLabel("Filtrar por tipo de nodo").selectOption("file");
    await page.getByLabel("Filtrar por extensión").selectOption(".ts");
    await page.getByRole("button", { name: "Encuadrar" }).click();
    await expect(page.locator('.semantic-node[aria-label="file: index.ts"]')).toBeVisible();

    const openIndexInEditor = page.getByRole("button", {
      name: "Abrir index.ts en editor",
    });
    const realFileRead = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/files/read") &&
        response.status() === 200,
    );
    await openIndexInEditor.focus();
    await openIndexInEditor.press("Enter");
    await realFileRead;
    await expect(page.getByTestId("editor-panel")).toBeVisible();
    await expect(page.locator(".editor-breadcrumbs")).toContainText("src");
    await expect(page.locator(".editor-breadcrumbs")).toContainText("index.ts");
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("export");
    await page.getByRole("button", { name: "Restablecer filtros" }).click();

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
    await expect(page.getByRole("status").filter({ hasText: "Agente local conectado" })).toBeVisible({ timeout: 8_000 });
    await expect(terminal.locator(".xterm-rows")).toContainText("RECOVERED_CHUNK", { timeout: 8_000 });

    const anchoredPtyCreated = page.waitForResponse(
      (response) => response.url().endsWith("/api/v1/terminals") && response.status() === 201,
    );
    await page.getByLabel("Filtrar por tipo de nodo").selectOption("directory");
    await page.getByRole("button", { name: "Encuadrar" }).click();
    await page
      .getByRole("group", { name: "directory: src", exact: true })
      .getByRole("button", { name: "Abrir terminal en src", exact: true })
      .dispatchEvent("click");
    const anchoredPty = (await (await anchoredPtyCreated).json()) as { cwd: string };
    expect(anchoredPty.cwd).toBe("src");
    await expect(terminalPanels.first().locator(".xterm-rows")).toContainText("src");

    await page.getByRole("tab", { name: "Actuar" }).click();
    await expect(page.getByRole("tab", { name: "Actuar" })).toHaveAttribute("aria-selected", "true");
    await page.waitForTimeout(650);

    expect(runtimeErrors).toEqual([]);
  });

  test("filters the connected graph by node type and extension", async ({ page }) => {
    await openConnectedWorkspace(page, {
      expectedName: "sample-workspace",
      expectedMode: "Edición",
    });

    const typeFilter = page.getByLabel("Filtrar por tipo de nodo");
    const extensionFilter = page.getByLabel("Filtrar por extensión");
    await expect(typeFilter).toBeVisible();
    await expect(extensionFilter).toBeVisible();

    await typeFilter.selectOption("function");
    await page.getByRole("button", { name: "Encuadrar" }).click();
    await expect(
      page.locator('.semantic-node[aria-label="function: answerProjectQuestion"]'),
    ).toBeVisible();
    await expect(
      page.locator('.semantic-node[aria-label="file: index.ts"]'),
    ).toHaveCount(0);

    await typeFilter.selectOption("all");
    await extensionFilter.selectOption(".py");
    await page.getByRole("button", { name: "Encuadrar" }).click();
    await expect(
      page.locator('.semantic-node[aria-label="file: service.py"]'),
    ).toBeVisible();
    await expect(
      page.locator('.semantic-node[aria-label="file: index.ts"]'),
    ).toHaveCount(0);

    await page.getByRole("button", { name: "Restablecer filtros" }).click();
    await page.getByRole("button", { name: "Encuadrar" }).click();
    await expect(
      page.locator('.semantic-node[aria-label="file: index.ts"]'),
    ).toBeVisible();
  });

  test("uses Ask Local without an API key and opens a verified result", async ({ page }) => {
    await openConnectedWorkspace(page, {
      expectedName: "sample-workspace",
      expectedMode: "Edición",
    });

    await expect(
      page.getByLabel("Modos del workspace").getByText("Ask Local", {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "Preguntar" }).click();
    const question = page.getByRole("textbox", { name: "Pregunta" });
    await question.fill("answerProjectQuestion");
    await page.getByRole("button", { name: "Consultar" }).click();

    const localResults = page
      .getByLabel(/Resultados locales de la consulta/)
      .last();
    await expect(localResults).toBeVisible();
    await expect(localResults).toContainText("answerProjectQuestion");
    await expect(localResults).toContainText("src/query-service.ts");
    await localResults
      .getByRole("button")
      .filter({ hasText: "answerProjectQuestion" })
      .first()
      .click();
    await expect(page.locator(".editor-breadcrumbs")).toContainText(
      "query-service.ts",
    );
    await expect(page.locator(".monaco-editor .view-lines")).toContainText(
      "answerProjectQuestion",
    );
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

    await openConnectedWorkspace(page, {
      expectedName: "sample-workspace",
      expectedMode: "Edición",
    });
    await expect(page.getByRole("status").filter({ hasText: "Agente local conectado" })).toBeVisible();
    await page.getByRole("tab", { name: "Actuar" }).click();
    await expect(page.getByRole("tab", { name: "Actuar" })).toHaveAttribute("aria-selected", "true");
    const terminalPanels = page.getByTestId("terminal-panel");
    if ((await terminalPanels.count()) < 2) {
      const terminalCreated = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/v1/terminals") &&
          response.status() === 201,
      );
      await page.getByRole("button", { name: "Nueva terminal" }).click();
      await terminalCreated;
    }
    await expect.poll(() => terminalPanels.count()).toBeGreaterThanOrEqual(2);
    await page.getByLabel("Filtrar por tipo de nodo").selectOption("file");
    await page.getByLabel("Filtrar por extensión").selectOption(".ts");
    await page.getByRole("button", { name: "Encuadrar" }).click();
    await page
      .getByRole("button", { name: "Abrir index.ts en editor" })
      .click();
    await page.getByRole("button", { name: "Restablecer filtros" }).click();
    await expect(page.locator(".editor-breadcrumbs")).toContainText("index.ts");
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("export");
    await expect(page.locator(".xterm").first()).toBeVisible();
    terminalCreates = 0;
    terminalDeletes = 0;

    const editor = page.locator(".monaco-editor");
    await editor.click();
    await page.keyboard.press("Meta+ArrowDown");
    await page.keyboard.insertText("\n// borrador local Constelix");
    await expect(page.getByText("Modificado", { exact: true })).toBeVisible();

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
    await page.getByLabel("Filtrar por tipo de nodo").selectOption("function");
    await page.getByLabel("Filtrar por extensión").selectOption(".ts");
    await page.getByRole("button", { name: "Encuadrar" }).click();
    await expect(
      page.locator('.semantic-node[aria-label="function: e2eGraphSignal"]'),
    ).toBeVisible({ timeout: 3_000 });
  });

  test("enforces read-only UI, API, Act, and PTY boundaries", async ({ page }) => {
    if (!temporaryDirectory) {
      throw new Error("The temporary E2E directory was not initialized.");
    }
    await server?.close();

    const readOnlyRoot = join(temporaryDirectory, "v003-typescript-read-only");
    await cp(readOnlyFixtureRoot, readOnlyRoot, { recursive: true });
    workspaceRoot = readOnlyRoot;
    server = await startAgentServer({
      workspaceRoot: readOnlyRoot,
      readOnly: true,
      dev: true,
      devOrigin: webOrigin,
      port: agentPort,
      capabilityToken,
      storageDirectory: join(temporaryDirectory, "read-only-state"),
      databasePath: join(temporaryDirectory, "read-only.sqlite"),
      askOptions: { apiKey: "" },
    });
    await waitForIndex(server);

    const terminalCreated = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/terminals") &&
        response.status() === 201,
    );
    await openConnectedWorkspace(page, {
      expectedName: "v003-typescript-read-only",
      expectedMode: "Lectura",
    });
    const terminal = (await (await terminalCreated).json()) as { id: string };

    await expect(
      page.getByLabel("Modos del workspace").getByText("Act bloqueado", {
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Abrir index.ts en editor" })
      .click();
    await expect(page.getByRole("button", { name: "Guardar archivo" })).toBeDisabled();
    await expect(page.locator(".monaco-editor textarea").first()).not.toBeEditable();

    await page.getByRole("tab", { name: "Actuar" }).click();
    await expect(
      page.getByText("Actuar bloqueado en Modo Lectura"),
    ).toBeVisible();

    const writeAttempt = await page.evaluate(
      async ({ token }) => {
        const response = await fetch("/api/v1/files/write", {
          method: "PUT",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            protocolVersion: 1,
            relativePath: "src/read-only-proof.ts",
            content: "export const shouldNotExist = true;",
            expectedContentHash: "missing",
          }),
        });
        return {
          status: response.status,
          body: await response.text(),
        };
      },
      { token: capabilityToken },
    );
    expect(writeAttempt.status).toBe(403);
    expect(writeAttempt.body).toContain("WORKSPACE_READ_ONLY");
    expect(writeAttempt.body).not.toContain(readOnlyRoot);

    await writeTerminalCommand(
      page,
      terminal.id,
      "touch terminal-write-proof.txt\r",
      "Operation not permitted",
    );
    await expect(
      access(join(readOnlyRoot, "terminal-write-proof.txt")),
    ).rejects.toThrow();
  });

  test("renders provider errors without leaking local paths or secrets", async ({ page }) => {
    if (!temporaryDirectory) {
      throw new Error("The temporary E2E directory was not initialized.");
    }
    await server?.close();

    const errorRoot = join(temporaryDirectory, "v003-redacted-errors");
    await cp(readOnlyFixtureRoot, errorRoot, { recursive: true });
    workspaceRoot = errorRoot;
    const leakedToken = "sk-constelixE2eSecretToken123456";
    server = await startAgentServer({
      workspaceRoot: errorRoot,
      dev: true,
      devOrigin: webOrigin,
      port: agentPort,
      capabilityToken,
      storageDirectory: join(temporaryDirectory, "redacted-error-state"),
      databasePath: join(temporaryDirectory, "redacted-error.sqlite"),
      askOptions: {
        provider: {
          async stream() {
            throw new Error(
              `No se pudo inspeccionar ${join(errorRoot, "src/index.ts")} con ${leakedToken}.`,
            );
          },
        },
      },
      codexOptions: {
        getCodexVersion: async () => undefined,
      },
    });
    await waitForIndex(server);

    await openConnectedWorkspace(page, {
      expectedName: "v003-redacted-errors",
      expectedMode: "Edición",
      expectedAskMode: "Ask OpenAI",
    });
    await page.getByRole("textbox", { name: "Pregunta" }).fill("index.ts");
    await page.getByRole("button", { name: "Consultar" }).click();

    const visibleError = page.getByRole("alert");
    await expect(visibleError).toBeVisible();
    await expect(visibleError).toContainText("<workspace>/src/index.ts");
    await expect(visibleError).not.toContainText(errorRoot);
    await expect(visibleError).not.toContainText(leakedToken);
    await expect(visibleError).toContainText("[REDACTED_CREDENTIAL]");
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

async function openConnectedWorkspace(
  page: Page,
  options: {
    expectedName: string;
    expectedMode: "Lectura" | "Edición";
    expectedAskMode?: "Ask Local" | "Ask OpenAI";
  },
): Promise<void> {
  await page.goto(`/#token=${encodeURIComponent(capabilityToken)}`);
  const onboarding = page.getByRole("dialog", {
    name: options.expectedName,
  });
  await expect(onboarding).toBeVisible();
  await expect(onboarding.getByText("Archivos detectados")).toBeVisible();
  await expect(onboarding.getByText("Lenguajes")).toBeVisible();
  await expect(onboarding.getByText("Tipo de proyecto")).toBeVisible();
  await expect(
    onboarding.getByRole("progressbar", {
      name: "Progreso de indexación",
    }),
  ).toBeVisible();
  await expect(
    page
      .getByLabel("Modos del workspace")
      .getByText(options.expectedMode, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Modos del workspace").getByText(
      options.expectedAskMode ?? "Ask Local",
      {
      exact: true,
      },
    ),
  ).toBeVisible();
  const displayedPath = await page
    .locator(".workspace-identity span")
    .textContent();
  expect(displayedPath).not.toContain("/private/");
  await onboarding
    .getByRole("button", {
      name: /Abrir workspace|Entrar mientras indexa/,
    })
    .click();
  await expect(onboarding).toHaveCount(0);
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535
    ? port
    : fallback;
}
