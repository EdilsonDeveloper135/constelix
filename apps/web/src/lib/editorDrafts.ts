export type EditorDraftStatus =
  | "idle"
  | "loading"
  | "saving"
  | "saved"
  | "conflict"
  | "error";

export interface EditorDraft {
  workspaceId: string;
  relativePath: string;
  content: string;
  savedContent: string;
  contentHash?: string;
  language: string;
  loaded: boolean;
  status: EditorDraftStatus;
  errorMessage?: string;
}

const drafts = new Map<string, EditorDraft>();

export function editorResourceKey(
  workspaceId: string,
  relativePath: string,
): string {
  return `${workspaceId}\u0000${relativePath}`;
}

export function getOrCreateEditorDraft(
  workspaceId: string,
  relativePath: string,
  fallback: Omit<EditorDraft, "workspaceId" | "relativePath">,
): EditorDraft {
  const key = editorResourceKey(workspaceId, relativePath);
  const existing = drafts.get(key);
  if (existing) return existing;
  const draft = { workspaceId, relativePath, ...fallback };
  drafts.set(key, draft);
  return draft;
}

export function getEditorDraft(
  workspaceId: string,
  relativePath: string,
): EditorDraft | undefined {
  return drafts.get(editorResourceKey(workspaceId, relativePath));
}

export function updateEditorDraft(
  workspaceId: string,
  relativePath: string,
  patch: Partial<Omit<EditorDraft, "workspaceId" | "relativePath">>,
): EditorDraft {
  const key = editorResourceKey(workspaceId, relativePath);
  const current = drafts.get(key);
  if (!current) throw new Error(`Editor draft is not initialized: ${relativePath}`);
  const next = { ...current, ...patch };
  drafts.set(key, next);
  return next;
}

export function markEditorDraftPersisted(
  workspaceId: string,
  relativePath: string,
  savedContent: string,
  contentHash: string,
): EditorDraft {
  return updateEditorDraft(workspaceId, relativePath, {
    savedContent,
    contentHash,
    status: "saved",
  });
}

export function editorDraftIsDirty(
  workspaceId: string,
  relativePath: string,
): boolean {
  const draft = getEditorDraft(workspaceId, relativePath);
  return draft ? draft.content !== draft.savedContent : false;
}

export function clearEditorDraftsForWorkspace(workspaceId: string): void {
  const prefix = `${workspaceId}\u0000`;
  for (const key of drafts.keys()) {
    if (key.startsWith(prefix)) drafts.delete(key);
  }
}

export function listDirtyEditorDrafts(workspaceId: string): EditorDraft[] {
  const prefix = `${workspaceId}\u0000`;
  return [...drafts.entries()]
    .filter(([key, draft]) =>
      key.startsWith(prefix) && draft.content !== draft.savedContent
    )
    .map(([, draft]) => draft);
}

export function clearEditorDraftsForTests(): void {
  drafts.clear();
}
