import { beforeEach, describe, expect, it } from "vitest";

import {
  clearEditorDraftsForTests,
  editorDraftIsDirty,
  getEditorDraft,
  getOrCreateEditorDraft,
  updateEditorDraft,
} from "./editorDrafts";

describe("editor draft lifecycle", () => {
  beforeEach(clearEditorDraftsForTests);

  it("preserves an unsaved draft across component-style remounts", () => {
    getOrCreateEditorDraft("src/main.ts", {
      content: "export const value = 1;\n",
      savedContent: "export const value = 1;\n",
      contentHash: "hash-1",
      language: "typescript",
      loaded: true,
      status: "idle",
    });
    updateEditorDraft("src/main.ts", { content: "export const value = 2;\n" });

    expect(editorDraftIsDirty("src/main.ts")).toBe(true);
    expect(getOrCreateEditorDraft("src/main.ts", {
      content: "",
      savedContent: "",
      language: "typescript",
      loaded: false,
      status: "loading",
    }).content).toContain("value = 2");
  });

  it("keeps a conflict until the user explicitly resolves it", () => {
    getOrCreateEditorDraft("src/main.ts", {
      content: "local",
      savedContent: "base",
      contentHash: "old",
      language: "typescript",
      loaded: true,
      status: "idle",
    });
    updateEditorDraft("src/main.ts", { status: "conflict" });
    expect(getEditorDraft("src/main.ts")?.status).toBe("conflict");
    expect(editorDraftIsDirty("src/main.ts")).toBe(true);
  });
});
