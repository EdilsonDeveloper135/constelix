import { beforeEach, describe, expect, it } from "vitest";

import {
  clearEditorDraftsForTests,
  editorDraftIsDirty,
  getEditorDraft,
  getOrCreateEditorDraft,
  markEditorDraftPersisted,
  updateEditorDraft,
} from "./editorDrafts";

describe("editor draft lifecycle", () => {
  const workspaceId = "workspace-one";

  beforeEach(clearEditorDraftsForTests);

  it("preserves an unsaved draft across component-style remounts", () => {
    getOrCreateEditorDraft(workspaceId, "src/main.ts", {
      content: "export const value = 1;\n",
      savedContent: "export const value = 1;\n",
      contentHash: "hash-1",
      language: "typescript",
      loaded: true,
      status: "idle",
    });
    updateEditorDraft(workspaceId, "src/main.ts", { content: "export const value = 2;\n" });

    expect(editorDraftIsDirty(workspaceId, "src/main.ts")).toBe(true);
    expect(getOrCreateEditorDraft(workspaceId, "src/main.ts", {
      content: "",
      savedContent: "",
      language: "typescript",
      loaded: false,
      status: "loading",
    }).content).toContain("value = 2");
  });

  it("keeps a conflict until the user explicitly resolves it", () => {
    getOrCreateEditorDraft(workspaceId, "src/main.ts", {
      content: "local",
      savedContent: "base",
      contentHash: "old",
      language: "typescript",
      loaded: true,
      status: "idle",
    });
    updateEditorDraft(workspaceId, "src/main.ts", { status: "conflict" });
    expect(getEditorDraft(workspaceId, "src/main.ts")?.status).toBe("conflict");
    expect(editorDraftIsDirty(workspaceId, "src/main.ts")).toBe(true);
  });

  it("does not mark edits made during an in-flight save as persisted", () => {
    getOrCreateEditorDraft(workspaceId, "src/main.ts", {
      content: "sent to disk",
      savedContent: "original",
      contentHash: "hash-1",
      language: "typescript",
      loaded: true,
      status: "saving",
    });
    updateEditorDraft(workspaceId, "src/main.ts", { content: "typed while saving" });

    markEditorDraftPersisted(workspaceId, "src/main.ts", "sent to disk", "hash-2");

    expect(getEditorDraft(workspaceId, "src/main.ts")).toMatchObject({
      content: "typed while saving",
      savedContent: "sent to disk",
      contentHash: "hash-2",
    });
    expect(editorDraftIsDirty(workspaceId, "src/main.ts")).toBe(true);
  });

  it("isolates identical relative paths between workspaces", () => {
    getOrCreateEditorDraft("workspace-a", "src/main.ts", {
      content: "workspace a",
      savedContent: "workspace a",
      language: "typescript",
      loaded: true,
      status: "idle",
    });
    getOrCreateEditorDraft("workspace-b", "src/main.ts", {
      content: "workspace b",
      savedContent: "workspace b",
      language: "typescript",
      loaded: true,
      status: "idle",
    });

    updateEditorDraft("workspace-a", "src/main.ts", {
      content: "workspace a edited",
    });

    expect(getEditorDraft("workspace-a", "src/main.ts")?.content).toBe(
      "workspace a edited",
    );
    expect(getEditorDraft("workspace-b", "src/main.ts")?.content).toBe(
      "workspace b",
    );
  });
});
