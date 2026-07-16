export type EditorDraftStatus =
  | "idle"
  | "loading"
  | "saving"
  | "saved"
  | "conflict"
  | "error";

export interface EditorDraft {
  relativePath: string;
  content: string;
  savedContent: string;
  contentHash?: string;
  language: string;
  loaded: boolean;
  status: EditorDraftStatus;
}

const drafts = new Map<string, EditorDraft>();

export function getOrCreateEditorDraft(
  relativePath: string,
  fallback: Omit<EditorDraft, "relativePath">,
): EditorDraft {
  const existing = drafts.get(relativePath);
  if (existing) return existing;
  const draft = { relativePath, ...fallback };
  drafts.set(relativePath, draft);
  return draft;
}

export function getEditorDraft(relativePath: string): EditorDraft | undefined {
  return drafts.get(relativePath);
}

export function updateEditorDraft(
  relativePath: string,
  patch: Partial<Omit<EditorDraft, "relativePath">>,
): EditorDraft {
  const current = drafts.get(relativePath);
  if (!current) throw new Error(`Editor draft is not initialized: ${relativePath}`);
  const next = { ...current, ...patch };
  drafts.set(relativePath, next);
  return next;
}

export function editorDraftIsDirty(relativePath: string): boolean {
  const draft = drafts.get(relativePath);
  return draft ? draft.content !== draft.savedContent : false;
}

export function clearEditorDraftsForTests(): void {
  drafts.clear();
}
