import { expect, test } from "@playwright/test";

test("renders the complete visual workspace without runtime errors", async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });

  await page.goto("/");

  await expect(page).toHaveTitle("Constelix");
  await expect(page.getByTestId("workspace-canvas")).toBeVisible();
  await expect(page.getByTestId("editor-panel")).toBeVisible();
  await expect(page.getByTestId("terminal-panel")).toBeVisible();
  await expect(page.locator(".monaco-editor")).toBeVisible();
  await expect(page.locator(".xterm")).toBeVisible();
  await page.getByRole("tab", { name: "Asistente" }).click();
  await expect(page.getByTestId("ask-panel")).toBeVisible();
  await expect(page.getByText("Modo demostración")).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test("asks with evidence and requires explicit approval before acting", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Asistente" }).click();

  const evidenceAnimationLatency = page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        let evidenceVisibleAt: number | undefined;
        let timeout = 0;
        const observer = new MutationObserver(() => {
          if (
            evidenceVisibleAt === undefined &&
            document.querySelector('[aria-label^="Evidencia de la respuesta"]')
          ) {
            evidenceVisibleAt = performance.now();
          }
          if (
            evidenceVisibleAt !== undefined &&
            document.querySelector(".semantic-node--evidence-current")
          ) {
            window.clearTimeout(timeout);
            observer.disconnect();
            resolve(performance.now() - evidenceVisibleAt);
          }
        });
        timeout = window.setTimeout(() => {
          observer.disconnect();
          reject(new Error("Evidence animation did not start."));
        }, 3_000);
        observer.observe(document.body, {
          attributes: true,
          childList: true,
          subtree: true,
        });
      }),
  );
  const question = page.getByRole("textbox", { name: "Pregunta" });
  await question.fill("¿Cómo llega una consulta al grafo?");
  await page.getByRole("button", { name: "Consultar" }).click();
  await expect(page.getByText(/La consulta entra por/)).toBeVisible();
  const historicalEvidence = page.getByLabel(/Evidencia de la respuesta/).last();
  await expect(historicalEvidence).toBeVisible();
  expect(await evidenceAnimationLatency).toBeLessThan(250);
  await historicalEvidence.getByRole("button").first().click();
  await expect(page.locator(".editor-breadcrumbs")).toContainText("query.ts");

  await page.getByRole("tab", { name: "Asistente" }).click();
  await page.getByRole("tab", { name: "Actuar" }).click();
  await expect(page.getByTestId("act-panel")).toBeVisible();
  await page
    .getByRole("textbox", { name: "Objetivo del turno" })
    .fill("Documenta el flujo de consultas del grafo.");
  await page.getByRole("button", { name: "Preparar tarea" }).click();
  await expect(page.getByText("Revisa antes de aprobar")).toBeVisible();
  await expect(page.getByText("Raíz:", { exact: false })).toBeVisible();
  await expect(page.getByText("Expira:", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Aprobar turno" })).toBeVisible();
  await page.getByRole("button", { name: "Aprobar turno" }).click();
  await expect(page.getByText("Tarea completada")).toBeVisible();
  await page.getByRole("button", { name: "Nueva tarea" }).click();
  await expect(page.getByRole("button", { name: "Preparar tarea" })).toBeVisible();
});

test("supports keyboard navigation and restores focus around modal UI", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Asistente" }).click();

  const askTab = page.getByRole("tab", { name: "Preguntar" });
  const actTab = page.getByRole("tab", { name: "Actuar" });
  await askTab.focus();
  await askTab.press("ArrowRight");
  await expect(actTab).toBeFocused();
  await expect(actTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Actuar" })).toBeVisible();
  await expect(page.getByText("Act solo debe aprobarse en repositorios confiables.")).toBeVisible();

  await actTab.press("Home");
  await expect(askTab).toBeFocused();
  await expect(page.getByRole("tabpanel", { name: "Preguntar" })).toBeVisible();

  await page.getByRole("button", { name: "Encuadrar" }).click();
  const semanticNode = page.locator(
    '.semantic-node[aria-label="directory: apps/web"]',
  );
  await expect(semanticNode).toHaveAttribute("role", "group");
  await expect(semanticNode).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("rf__node-dir-web")).toHaveAttribute(
    "aria-label",
    "directory: apps/web",
  );

  const commandTrigger = page.getByRole("button", {
    name: /Buscar o ejecutar comando/,
  });
  await commandTrigger.focus();
  await commandTrigger.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Paleta de comandos" });
  const search = page.getByRole("textbox", { name: "Buscar comandos" });
  await expect(dialog).toBeVisible();
  await expect(search).toBeFocused();

  await search.press("Shift+Tab");
  const lastOption = dialog.getByRole("option").last();
  await expect(lastOption).toBeFocused();
  await lastOption.press("Tab");
  await expect(search).toBeFocused();

  await search.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(commandTrigger).toBeFocused();
});
