import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

import {
  startAgentServer,
  type RunningAgentServer,
} from "../../apps/agent/src/server";

const capabilityToken = "constelix-e2e-capability";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(repositoryRoot, "tests/fixtures/sample-workspace");

let server: RunningAgentServer | undefined;
let temporaryDirectory: string | undefined;

test.describe("workspace connected to the local agent", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "constelix-e2e-"));
    server = await startAgentServer({
      workspaceRoot,
      dev: true,
      devOrigin: "http://127.0.0.1:5173",
      port: 4321,
      capabilityToken,
      databasePath: join(temporaryDirectory, "constelix.sqlite"),
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

    // The store starts from demo panel resources while bootstrap is in flight. Once both
    // real resources are available, only errors from the connected flow are relevant here.
    runtimeErrors.length = 0;

    const semanticNodes = page.locator(".semantic-node");
    await expect.poll(() => semanticNodes.count()).toBeGreaterThan(5);
    await expect(page.locator('.semantic-node[aria-label="file: index.ts"]')).toBeVisible();
    await expect(page.locator('.semantic-node[aria-label="function: answerProjectQuestion"]')).toBeVisible();

    await page.locator('.semantic-node[aria-label="file: index.ts"]').dblclick({ force: true });
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
    await writeTerminalCommand(page, secondPty.id, "uname -s\r");
    await expect(terminal.locator(".xterm-rows")).toContainText("Darwin");

    expect(runtimeErrors).toEqual([]);
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

async function writeTerminalCommand(page: Page, terminalId: string, data: string): Promise<void> {
  await page.evaluate(
    ({ capabilityToken: token, terminalId: id, data: command }) =>
      new Promise<void>((resolveCommand, rejectCommand) => {
        const socket = new WebSocket(`ws://${window.location.host}/api/v1/events`);
        const timeout = window.setTimeout(() => {
          socket.close();
          rejectCommand(new Error("PTY output timed out."));
        }, 5_000);

        socket.addEventListener("open", () => {
          socket.send(JSON.stringify({ protocolVersion: 1, type: "auth", token }));
        });
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data)) as {
            type?: string;
            terminalId?: string;
            data?: string;
          };
          if (message.type === "authenticated") {
            socket.send(JSON.stringify({
              protocolVersion: 1,
              type: "terminal.input",
              terminalId: id,
              data: command,
            }));
          }
          if (message.type === "terminal.output" && message.terminalId === id && message.data?.includes("Darwin")) {
            window.clearTimeout(timeout);
            socket.close();
            resolveCommand();
          }
        });
        socket.addEventListener("error", () => {
          window.clearTimeout(timeout);
          rejectCommand(new Error("PTY WebSocket failed."));
        });
      }),
    { capabilityToken, terminalId, data },
  );
}
