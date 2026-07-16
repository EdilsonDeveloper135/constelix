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
  await expect(page.getByTestId("ask-panel")).toBeVisible();
  await expect(page.locator(".monaco-editor")).toBeVisible();
  await expect(page.locator(".xterm")).toBeVisible();
  await expect(page.getByText("Modo demostración")).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test("asks with evidence and requires explicit approval before acting", async ({ page }) => {
  await page.goto("/");

  const question = page.getByLabel("Pregunta");
  await question.fill("¿Cómo llega una consulta al grafo?");
  await page.getByRole("button", { name: "Consultar" }).click();
  await expect(page.getByText(/La consulta entra por/)).toBeVisible();
  await expect(page.getByLabel("Recorrido de evidencia")).toBeVisible();

  await page.getByRole("tab", { name: "Actuar" }).click();
  await expect(page.getByTestId("act-panel")).toBeVisible();
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
