import {
  access,
  cp,
  mkdtemp,
  mkdir,
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
let paginationRoot: string | undefined;

test.describe.configure({ mode: "serial" });

test.describe("workspace connected to the local agent", () => {
  test.beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "constelix-e2e-"));
    workspaceRoot = join(temporaryDirectory, "sample-workspace");
    paginationRoot = join(temporaryDirectory, "many-folders");
    await mkdir(paginationRoot);
    await Promise.all(
      Array.from({ length: 105 }, (_, index) =>
        mkdir(join(paginationRoot!, `folder-${String(index).padStart(3, "0")}`))
      ),
    );
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

    await page.getByRole("button", { name: "Encuadrar" }).click();
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
    const bottomDockTabs = page
      .getByTestId("workspace-dock-bottom")
      .getByRole("tab");
    await expect(bottomDockTabs).toHaveCount(1);
    const secondPtyCreated = page.waitForResponse(
      (response) => response.url().endsWith("/api/v1/terminals") && response.status() === 201,
    );
    await page.getByRole("button", { name: "Nueva terminal" }).click();
    const secondPtyResponse = await secondPtyCreated;
    const secondPty = (await secondPtyResponse.json()) as { id: string };
    await expect(bottomDockTabs).toHaveCount(2);
    await expect(terminalPanels).toHaveCount(2);

    const terminal = page.locator('[data-testid="terminal-panel"]:visible');
    await expect(terminal).toHaveCount(1);
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
    await expect(terminal.locator(".xterm-rows")).toContainText("src");

    await page.getByRole("tab", { name: "Asistente" }).click();
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

  test("opens an accessible context menu before creating a terminal", async ({ page }) => {
    let terminalCreates = 0;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/v1/terminals" && request.method() === "POST") {
        terminalCreates += 1;
      }
    });
    await openConnectedWorkspace(page, {
      expectedName: "sample-workspace",
      expectedMode: "Edición",
    });
    await expect(
      page.locator('[data-testid="terminal-panel"]:visible').first(),
    ).toBeVisible();
    terminalCreates = 0;

    await page.getByLabel("Filtrar por tipo de nodo").selectOption("directory");
    await page.getByRole("button", { name: "Encuadrar" }).click();
    const node = page.locator(
      '.react-flow__node[aria-label="directory: python"]',
    );
    await node.click({ button: "right" });

    const menu = page.getByTestId("semantic-node-context-menu");
    await expect(menu).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "Inspeccionar nodo" }),
    ).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(
      menu.getByRole("menuitem", { name: "Abrir terminal aquí" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      menu.getByRole("menuitem", { name: "Inspeccionar nodo" }),
    ).toBeFocused();
    await page.waitForTimeout(150);
    expect(terminalCreates).toBe(0);

    const terminalCreated = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/terminals") &&
        response.status() === 201,
    );
    await page.keyboard.press("End");
    await expect(
      menu.getByRole("menuitem", { name: "Abrir terminal aquí" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    const terminal = (await (await terminalCreated).json()) as { cwd: string };
    expect(terminal.cwd).toBe("python");
    expect(terminalCreates).toBe(1);
    await expect(menu).toHaveCount(0);

    await node.click({ button: "right" });
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    const nodeWrapper = node;
    await expect(nodeWrapper).toBeFocused();
    await expect(nodeWrapper).toHaveAttribute("aria-haspopup", "menu");

    await nodeWrapper.press("Shift+F10");
    await expect(menu).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "Inspeccionar nodo" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect(nodeWrapper).toBeFocused();
    await expect(nodeWrapper).toHaveClass(/selected/);
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
    await page.getByRole("tab", { name: "Asistente" }).click();
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
    await page.getByRole("tab", { name: "Asistente" }).click();
    await page.getByRole("tab", { name: "Actuar" }).click();
    await expect(page.getByRole("tab", { name: "Actuar" })).toHaveAttribute("aria-selected", "true");
    const terminalPanels = page.getByTestId("terminal-panel");
    const bottomDock = page.getByTestId("workspace-dock-bottom");
    const bottomDockTabs = bottomDock.getByRole("tab");
    if ((await bottomDockTabs.count()) < 2) {
      const terminalCreated = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/v1/terminals") &&
          response.status() === 201,
      );
      await page.getByRole("button", { name: "Nueva terminal" }).click();
      await terminalCreated;
    }
    await expect.poll(() => bottomDockTabs.count()).toBeGreaterThanOrEqual(2);
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
    await expect(page.locator(".editor-save-status")).not.toHaveText("Cargando");
    await expect(page.locator(".xterm:visible").first()).toBeVisible();
    terminalCreates = 0;
    terminalDeletes = 0;

    const editor = page.locator(".monaco-editor").first();
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.insertText("\n// borrador local Constelix");
    await expect(page.getByText("Modificado", { exact: true })).toBeVisible();

    for (let index = 0; index < 4; index += 1) {
      await page.getByRole("button", { name: "Alejar" }).click();
      await page.waitForTimeout(180);
    }
    await expect(page.getByText("Contenido suspendido a este nivel de zoom")).toHaveCount(0);
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("borrador local Constelix");
    await expect(page.locator(".xterm:visible").first()).toBeVisible();

    await bottomDock
      .getByRole("button", { name: "Desanclar panel al canvas" })
      .click();
    const dockTerminalBottom = page.getByRole("button", {
      name: "Anclar panel abajo",
    });
    await expect(dockTerminalBottom).toBeVisible();
    await dockTerminalBottom.focus();
    await dockTerminalBottom.press("Enter");

    const rightDock = page.getByTestId("workspace-dock-right");
    await rightDock
      .getByRole("button", { name: "Desanclar panel al canvas" })
      .click();
    const dockEditorRight = page.getByRole("button", {
      name: "Anclar panel a la derecha",
    });
    await expect(dockEditorRight).toBeVisible();
    await dockEditorRight.focus();
    await dockEditorRight.press("Enter");
    await expect(page.locator(".monaco-editor .view-lines")).toContainText(
      "borrador local Constelix",
    );

    for (let index = 0; index < 4; index += 1) {
      await page.getByRole("button", { name: "Acercar" }).click();
      await page.waitForTimeout(180);
    }
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("borrador local Constelix");
    await expect(page.locator(".xterm:visible").first()).toBeVisible();
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
    await page.keyboard.press("Control+End");
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

    const floatingLayoutSaved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/layout") &&
        response.request().method() === "PUT" &&
        response.status() === 200,
    );
    await rightDock
      .getByRole("button", { name: "Desanclar panel al canvas" })
      .click();
    await floatingLayoutSaved;
    await expect(
      page.getByRole("button", { name: "Anclar panel a la derecha" }),
    ).toHaveCount(1);

    await openConnectedWorkspace(page, {
      expectedName: "sample-workspace",
      expectedMode: "Edición",
    });
    await expect(
      page
        .getByTestId("workspace-dock-right")
        .getByRole("tab", { name: "Editor" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Anclar panel a la derecha" }),
    ).toHaveCount(1);
  });

  test("hydrates pristine settings opened before the agent configuration arrives", async ({ page }) => {
    let releaseSettingsLoad: (() => void) | undefined;
    let markSettingsRequestStarted: (() => void) | undefined;
    const settingsLoadGate = new Promise<void>((resolveGate) => {
      releaseSettingsLoad = resolveGate;
    });
    const settingsRequestStarted = new Promise<void>((resolveStarted) => {
      markSettingsRequestStarted = resolveStarted;
    });
    await page.route("**/api/v1/settings/llm", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      markSettingsRequestStarted?.();
      await settingsLoadGate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          protocolVersion: 1,
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "server-model-after-delay",
          providerKind: "ollama",
          apiKeyConfigured: false,
          apiKeyRequired: false,
          apiKeySource: "none",
        }),
      });
    });
    await openConnectedWorkspace(page, {
      expectedName: "sample-workspace",
      expectedMode: "Edición",
    });
    await settingsRequestStarted;

    const settingsButton = page
      .getByRole("button", { name: "Configuración" })
      .first();
    await settingsButton.click();
    const settings = page.getByTestId("settings-modal");
    await expect(settings.getByRole("status")).toContainText(
      "Cargando la configuración segura",
    );
    await expect(settings.getByRole("button", { name: "Cargando…" })).toBeDisabled();
    releaseSettingsLoad?.();
    await expect(settings.getByLabel("URL base del LLM")).toHaveValue(
      "http://127.0.0.1:11434/v1",
    );
    await expect(settings.getByLabel("Modelo")).toHaveValue(
      "server-model-after-delay",
    );
    await expect(
      settings.getByRole("button", { name: "Guardar configuración" }),
    ).toBeEnabled();
    await settings.getByRole("button", { name: "Cancelar" }).click();
    await expect(settingsButton).toBeFocused();
  });

  test("blocks an unsafe settings save after load failure and supports retry", async ({ page }) => {
    let failSettingsLoad = true;
    await page.route("**/api/v1/settings/llm", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      if (failSettingsLoad) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "temporary failure" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          protocolVersion: 1,
          baseUrl: "https://compatible.example/v1",
          model: "recovered-model",
          providerKind: "compatible",
          apiKeyConfigured: false,
          apiKeyRequired: true,
          apiKeySource: "none",
        }),
      });
    });
    const firstFailure = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/settings/llm") &&
        response.request().method() === "GET" &&
        response.status() === 503,
    );
    await openConnectedWorkspace(page, {
      expectedName: "sample-workspace",
      expectedMode: "Edición",
    });
    await firstFailure;

    await page.getByRole("button", { name: "Configuración" }).first().click();
    const settings = page.getByTestId("settings-modal");
    await expect(settings.getByRole("alert")).toContainText(
      "No se pudo cargar la configuración",
    );
    await expect(
      settings.getByRole("button", { name: "Guardar configuración" }),
    ).toBeDisabled();
    failSettingsLoad = false;
    await settings.getByRole("button", { name: "Reintentar carga" }).click();
    await expect(settings.getByLabel("URL base del LLM")).toHaveValue(
      "https://compatible.example/v1",
    );
    await expect(settings.getByLabel("Modelo")).toHaveValue("recovered-model");
    await expect(
      settings.getByRole("button", { name: "Guardar configuración" }),
    ).toBeEnabled();
  });

  test("configures a write-only local LLM credential and can clear it", async ({ page }) => {
    const secret = "constelix-e2e-write-only-credential";
    let releaseSettingsLoad: (() => void) | undefined;
    let markSettingsRequestStarted: (() => void) | undefined;
    const settingsLoadGate = new Promise<void>((resolveGate) => {
      releaseSettingsLoad = resolveGate;
    });
    const settingsRequestStarted = new Promise<void>((resolveStarted) => {
      markSettingsRequestStarted = resolveStarted;
    });
    await page.route("**/api/v1/settings/llm", async (route) => {
      if (route.request().method() === "GET") {
        markSettingsRequestStarted?.();
        await settingsLoadGate;
      }
      await route.continue();
    });
    await openConnectedWorkspace(page, {
      expectedName: "sample-workspace",
      expectedMode: "Edición",
    });
    await settingsRequestStarted;

    const settingsButton = page
      .getByRole("button", { name: "Configuración" })
      .first();
    await settingsButton.click();
    const settings = page.getByTestId("settings-modal");
    await expect(settings).toBeVisible();
    const baseUrlInput = settings.locator('input[name="llmBaseUrl"]');
    const modelInput = settings.locator('input[name="llmModel"]');
    const apiKeyInput = settings.locator('input[name="llmApiKey"]');
    await baseUrlInput.fill(
      "http://127.0.0.1:11434/v1",
    );
    await expect(baseUrlInput).toHaveValue(
      "http://127.0.0.1:11434/v1",
    );
    await modelInput.fill("qwen2.5-coder:7b");
    await expect(modelInput).toHaveValue("qwen2.5-coder:7b");
    await apiKeyInput.fill(secret);
    await expect(apiKeyInput).toHaveValue(secret);
    await expect(settings.getByRole("button", { name: "Cargando…" })).toBeDisabled();
    const loadedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/settings/llm") &&
        response.request().method() === "GET" &&
        response.status() === 200,
    );
    releaseSettingsLoad?.();
    await loadedResponse;
    await expect(baseUrlInput).toHaveValue(
      "http://127.0.0.1:11434/v1",
    );
    await expect(modelInput).toHaveValue(
      "qwen2.5-coder:7b",
    );

    const savedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/settings/llm") &&
        response.request().method() === "PUT" &&
        response.status() === 200,
    );
    await settings.getByRole("button", { name: "Guardar configuración" }).click();
    const saved = await (await savedResponse).json() as {
      apiKeyConfigured: boolean;
      apiKeySource: string;
      baseUrl: string;
      model: string;
    };
    expect(saved).toMatchObject({
      apiKeyConfigured: true,
      apiKeySource: "stored",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen2.5-coder:7b",
    });
    expect(JSON.stringify(saved)).not.toContain(secret);
    await expect(settings).toHaveCount(0);
    await expect(settingsButton).toBeFocused();

    const browserStorage = await page.evaluate(() => {
      const values = (storage: Storage) =>
        Array.from({ length: storage.length }, (_, index) =>
          storage.getItem(storage.key(index) ?? ""),
        );
      return {
        local: values(localStorage),
        session: values(sessionStorage),
        body: document.body.textContent ?? "",
      };
    });
    expect(JSON.stringify(browserStorage)).not.toContain(secret);

    await settingsButton.click();
    await expect(settings).toBeVisible();
    await settings.getByRole("button", { name: "Eliminar la clave guardada" }).click();
    const clearedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/settings/llm") &&
        response.request().method() === "PUT" &&
        response.status() === 200,
    );
    await settings.getByRole("button", { name: "Guardar configuración" }).click();
    const cleared = await (await clearedResponse).json() as {
      apiKeyConfigured: boolean;
      apiKeySource: string;
    };
    expect(cleared).toMatchObject({
      apiKeyConfigured: false,
      apiKeySource: "none",
    });
    expect(JSON.stringify(cleared)).not.toContain(secret);

    const resetStatus = await page.evaluate(async (token) => {
      const health = await fetch("/api/v1/health", {
        headers: { authorization: `Bearer ${token}` },
      });
      const active = await health.json() as { session: { id: string } };
      const response = await fetch("/api/v1/settings/llm", {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-constelix-workspace-session": active.session.id,
        },
        body: JSON.stringify({
          protocolVersion: 1,
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o",
          apiKey: { action: "clear" },
        }),
      });
      return response.status;
    }, capabilityToken);
    expect(resetStatus).toBe(200);
  });

  test("exposes Topbar workspace state and keeps the workspace dialog keyboard-accessible", async ({
    page,
  }) => {
    await openConnectedWorkspace(page, {
      expectedName: "sample-workspace",
      expectedMode: "Edición",
    });

    const trigger = page.getByRole("button", {
      name: "Cambiar workspace. Actual: sample-workspace",
    });
    await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(
      page.getByRole("status").filter({ hasText: "Agente local conectado" }),
    ).toBeVisible();
    const workspaceModes = page.getByLabel("Modos del workspace");
    await expect(
      workspaceModes.getByText("Edición", { exact: true }),
    ).toBeVisible();
    await expect(
      workspaceModes.getByText("Ask Local", { exact: true }),
    ).toBeVisible();

    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Cambiar workspace" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog).toHaveAttribute("aria-busy", "false");
    await expect(dialog).toHaveAccessibleDescription(
      "Abre una carpeta sin recargar Constelix.",
    );
    await expect(trigger).toHaveAttribute("aria-expanded", "true");

    const recentFilter = dialog.getByRole("searchbox", {
      name: "Filtrar workspaces recientes",
    });
    await expect(recentFilter).toBeFocused();
    const recentWorkspace = dialog
      .getByRole("button")
      .filter({ hasText: "sample-workspace" })
      .first();
    await expect(recentWorkspace).toBeEnabled();

    await recentFilter.fill("workspace que no existe");
    await expect(
      dialog.getByText("No hay workspaces recientes que coincidan."),
    ).toBeVisible();
    await recentFilter.fill("");
    await expect(recentWorkspace).toBeVisible();

    const browseResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/fs/browse" &&
        response.status() === 200,
    );
    await dialog
      .getByRole("button", { name: "Explorar carpeta personal" })
      .click();
    await browseResponse;
    const openCurrent = dialog.getByRole("button", {
      name: "Abrir esta carpeta",
    });
    await expect(openCurrent).toBeVisible();

    const closeButton = dialog.getByRole("button", {
      name: "Cerrar selector de workspace",
    });
    await closeButton.focus();
    await closeButton.press("Shift+Tab");
    await expect(openCurrent).toBeFocused();
    await openCurrent.press("Tab");
    await expect(closeButton).toBeFocused();

    await closeButton.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    await trigger.click();
    const reopenedDialog = page.getByRole("dialog", {
      name: "Cambiar workspace",
    });
    const reopenRequest = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === "/api/v1/workspaces/open" &&
        request.method() === "POST",
    );
    await reopenedDialog
      .getByRole("button")
      .filter({ hasText: "sample-workspace" })
      .first()
      .click();
    const recentRequestBody = (await reopenRequest).postDataJSON() as {
      target: { kind: string; workspaceId?: string };
    };
    expect(recentRequestBody.target).toMatchObject({
      kind: "recent",
      workspaceId: expect.any(String),
    });
    await expect(reopenedDialog).toHaveCount(0);
  });

  test("requires an explicit decision before switching with a dirty editor", async ({
    page,
  }) => {
    await openConnectedWorkspace(page, {
      expectedName: "sample-workspace",
      expectedMode: "Edición",
    });
    await page.getByRole("button", { name: "Archivos", exact: true }).click();
    await page
      .getByRole("button", { name: "index.ts", exact: true })
      .click();
    const editor = page.locator(".monaco-editor").first();
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.insertText("\n// borrador para cambio de workspace");
    await expect(page.getByText("Modificado", { exact: true })).toBeVisible();

    const trigger = page.getByRole("button", {
      name: "Cambiar workspace. Actual: sample-workspace",
    });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Cambiar workspace" });
    await dialog
      .getByRole("button")
      .filter({ hasText: "sample-workspace" })
      .first()
      .click();

    const dirtyGuard = dialog.getByRole("alert");
    await expect(dirtyGuard).toContainText("Hay cambios sin guardar");
    await expect(dirtyGuard).toBeFocused();
    await expect(
      dirtyGuard.getByRole("button", { name: "Cancelar" }),
    ).toBeVisible();
    await expect(
      dirtyGuard.getByRole("button", { name: "Descartar" }),
    ).toBeVisible();
    await expect(
      dirtyGuard.getByRole("button", { name: "Conservar y cambiar" }),
    ).toBeVisible();

    await dirtyGuard.getByRole("button", { name: "Cancelar" }).click();
    await expect(dirtyGuard).toHaveCount(0);
    await expect(
      dialog.getByRole("searchbox", {
        name: "Filtrar workspaces recientes",
      }),
    ).toBeVisible();

    await dialog
      .getByRole("button")
      .filter({ hasText: "sample-workspace" })
      .first()
      .click();
    const preservedSwitch = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/workspaces/open" &&
        response.status() === 200,
    );
    await dialog
      .getByRole("button", { name: "Conservar y cambiar" })
      .click();
    await preservedSwitch;
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("Modificado", { exact: true })).toBeVisible();
    await expect(page.locator(".monaco-editor .view-lines")).toContainText(
      "borrador para cambio de workspace",
    );
  });

  test("loads every page of a large local directory listing", async ({ page }) => {
    if (!paginationRoot) {
      throw new Error("The pagination fixture was not initialized.");
    }
    await openConnectedWorkspace(page, {
      expectedName: "sample-workspace",
      expectedMode: "Edición",
    });
    await page.getByRole("button", {
      name: "Cambiar workspace. Actual: sample-workspace",
    }).click();
    const dialog = page.getByRole("dialog", { name: "Cambiar workspace" });
    await dialog.getByLabel("Ruta absoluta").fill(paginationRoot);
    const firstPage = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/v1/fs/browse" &&
        !url.searchParams.has("cursor") &&
        response.status() === 200
      );
    });
    await dialog
      .getByRole("button", { name: "Explorar carpeta personal" })
      .click();
    await firstPage;

    await expect(
      dialog.getByRole("button", { name: "folder-099" }),
    ).toBeAttached();
    await expect(
      dialog.getByRole("button", { name: "folder-104" }),
    ).toHaveCount(0);
    const loadMore = dialog.getByRole("button", {
      name: "Cargar más carpetas",
    });
    await expect(loadMore).toBeEnabled();
    const secondPage = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/v1/fs/browse" &&
        url.searchParams.has("cursor") &&
        response.status() === 200
      );
    });
    await loadMore.click();
    await secondPage;

    const finalDirectory = dialog.getByRole("button", {
      name: "folder-104",
    });
    await expect(finalDirectory).toBeAttached();
    await finalDirectory.scrollIntoViewIfNeeded();
    await expect(finalDirectory).toBeVisible();
    await expect(loadMore).toHaveCount(0);
  });

  test("renders a lock conflict and sends the guarded force-release intent", async ({
    page,
  }) => {
    await openConnectedWorkspace(page, {
      expectedName: "sample-workspace",
      expectedMode: "Edición",
    });
    const activeList = await page.evaluate(
      async ({ token }) => {
        const response = await fetch("/api/v1/workspaces", {
          headers: { authorization: `Bearer ${token}` },
        });
        return response.json() as Promise<{
          protocolVersion: 1;
          activeSession: {
            id: string;
            workspaceId: string;
            activatedAt: string;
          };
        }>;
      },
      { token: capabilityToken },
    );
    const targetWorkspaceId = "abcdefabcdefabcdefabcdef";
    const lockId = "b38cefe1-6435-4f36-ab6d-859af45da2b3";
    const conflict = {
      conflictId: "f497b469-84f2-4f35-93f0-2c5ec77fd54c",
      lockId,
      workspaceId: targetWorkspaceId,
      displayPath: "~/Projects/locked-workspace",
      status: "ambiguous",
      forceAllowed: true,
      pid: 4812,
      agentVersion: "v0.0.6",
      heartbeatAt: "2026-07-25T20:31:30.000Z",
    };
    await page.route("**/api/v1/workspaces", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          protocolVersion: 1,
          activeSession: activeList.activeSession,
          recents: [
            {
              protocolVersion: 1,
              workspaceId: targetWorkspaceId,
              name: "locked-workspace",
              displayPath: "~/Projects/locked-workspace",
              lastOpenedAt: "2026-07-25T20:30:00.000Z",
              availability: "locked",
              lastMode: "edit",
            },
          ],
        }),
      });
    });

    let openAttempt = 0;
    let forcedRequestBody: unknown;
    await page.route("**/api/v1/workspaces/open", async (route) => {
      openAttempt += 1;
      if (openAttempt === 2) {
        forcedRequestBody = route.request().postDataJSON();
      }
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          protocolVersion: 1,
          error: {
            code: "WORKSPACE_LOCK_CONFLICT",
            message: "El lock del workspace requiere una resolución explícita.",
            recoverable: true,
            details: conflict,
          },
        }),
      });
    });

    await page
      .getByRole("button", {
        name: "Cambiar workspace. Actual: sample-workspace",
      })
      .click();
    const dialog = page.getByRole("dialog", { name: "Cambiar workspace" });
    await dialog
      .getByRole("button")
      .filter({ hasText: "locked-workspace" })
      .click();

    const lockAlert = dialog.getByRole("alert");
    await expect(lockAlert).toContainText("Workspace en uso");
    await expect(lockAlert).toBeFocused();
    await expect(lockAlert).toContainText("PID");
    await expect(lockAlert).toContainText("4812");
    await expect(lockAlert).toContainText("v0.0.6");
    const forceButton = lockAlert.getByRole("button", {
      name: "Forzar liberación",
    });
    await expect(forceButton).toBeVisible();
    await forceButton.click();
    await expect.poll(() => openAttempt).toBe(2);
    expect(forcedRequestBody).toMatchObject({
      target: {
        kind: "recent",
        workspaceId: targetWorkspaceId,
      },
      lockResolution: {
        action: "force-release",
        expectedLockId: lockId,
        acknowledgeRisk: true,
      },
    });
    await expect(lockAlert).toBeVisible();
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

    await page.getByRole("tab", { name: "Asistente" }).click();
    await page.getByRole("tab", { name: "Actuar" }).click();
    await expect(
      page.getByText("Actuar bloqueado en Modo Lectura"),
    ).toBeVisible();

    const writeAttempt = await page.evaluate(
      async ({ token }) => {
        const health = await fetch("/api/v1/health", {
          headers: { authorization: `Bearer ${token}` },
        });
        const active = await health.json() as { session: { id: string } };
        const response = await fetch("/api/v1/files/write", {
          method: "PUT",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-constelix-workspace-session": active.session.id,
          },
          body: JSON.stringify({
            protocolVersion: 1,
            relativePath: "src/read-only-proof.ts",
            content: "export const shouldNotExist = true;",
            expectedContentHash: "0".repeat(64),
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
    const leakedToken = [
      "sk",
      "constelixE2eSecretToken123456",
    ].join("-");
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
      expectedAskMode: "Ask LLM",
    });
    await page.getByRole("tab", { name: "Asistente" }).click();
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
        const socket = new WebSocket(
          `ws://${window.location.host}/api/v1/events?token=${encodeURIComponent(token)}`,
        );
        let output = "";
        const timeout = window.setTimeout(() => {
          socket.close();
          rejectCommand(new Error("PTY output timed out."));
        }, 5_000);

        socket.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data)) as {
            type?: string;
            payload?: {
              terminalId?: string;
              data?: string;
            };
          };
          if (message.type === "connection.ready") {
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
        const socket = new WebSocket(
          `ws://${window.location.host}/api/v1/events?token=${encodeURIComponent(token)}`,
        );
        const timeout = window.setTimeout(() => {
          socket.close();
          rejectCommand(new Error("PTY input timed out."));
        }, 5_000);
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data)) as { type?: string };
          if (message.type !== "connection.ready") return;
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
    expectedAskMode?: "Ask Local" | "Ask LLM";
  },
): Promise<void> {
  await page.goto("about:blank");
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
