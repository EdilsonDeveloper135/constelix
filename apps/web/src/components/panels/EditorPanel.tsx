import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  RefreshCcw,
  Save,
  SplitSquareVertical,
  Upload,
} from "lucide-react";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { NodeProps } from "@xyflow/react";

import { apiClient } from "../../lib/api";
import {
  editorDraftIsDirty,
  getEditorDraft,
  getOrCreateEditorDraft,
  updateEditorDraft,
  type EditorDraft,
} from "../../lib/editorDrafts";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import type { EditorFlowNode, WorkspaceNode } from "../../types";
import { PanelFrame } from "./PanelFrame";

const MonacoEditor = lazy(async () => {
  const [module] = await Promise.all([
    import("@monaco-editor/react"),
    import("../../lib/monaco"),
  ]);
  return { default: module.default };
});

interface FileTreeItem {
  depth: number;
  type: "folder" | "file";
  name: string;
  relativePath?: string;
  open?: boolean;
  active?: boolean;
  dirty?: boolean;
}

const demoFileTree: FileTreeItem[] = [
  { depth: 0, type: "folder", name: "constelix", relativePath: ".", open: true },
  { depth: 1, type: "folder", name: ".git" },
  { depth: 1, type: "folder", name: "apps", open: true },
  { depth: 2, type: "folder", name: "local-agent", open: true },
  { depth: 3, type: "folder", name: "src", open: true },
  { depth: 4, type: "folder", name: "indexers", open: true },
  {
    depth: 5,
    type: "file",
    name: "GraphIndexer.ts",
    relativePath: "apps/local-agent/src/indexers/GraphIndexer.ts",
    active: true,
  },
  { depth: 4, type: "folder", name: "utils" },
  { depth: 4, type: "folder", name: "types" },
  {
    depth: 3,
    type: "file",
    name: "index.ts",
    relativePath: "apps/local-agent/src/index.ts",
  },
  { depth: 2, type: "folder", name: "web" },
  { depth: 1, type: "folder", name: "packages" },
  {
    depth: 1,
    type: "file",
    name: ".gitignore",
    relativePath: ".gitignore",
  },
  {
    depth: 1,
    type: "file",
    name: "package.json",
    relativePath: "package.json",
  },
  {
    depth: 1,
    type: "file",
    name: "tsconfig.json",
    relativePath: "tsconfig.json",
  },
];

function buildFileTree(
  nodes: WorkspaceNode[],
  workspaceName: string,
  activePath: string,
): FileTreeItem[] {
  const entries = new Map<string, FileTreeItem>();
  entries.set(".", {
    depth: 0,
    type: "folder",
    name: workspaceName,
    relativePath: ".",
    open: true,
  });

  for (const node of nodes) {
    if (
      node.type !== "semantic" ||
      (node.data.kind !== "file" && node.data.kind !== "directory")
    ) {
      continue;
    }
    const relativePath = node.data.relativePath;
    if (!relativePath || relativePath === ".") continue;
    const parts = relativePath.split("/").filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      const path = parts.slice(0, index + 1).join("/");
      const leafIsFile =
        index === parts.length - 1 && node.data.kind === "file";
      if (!entries.has(path) || leafIsFile) {
        entries.set(path, {
          depth: index + 1,
          type: leafIsFile ? "file" : "folder",
          name: parts[index]!,
          relativePath: path,
          open: !leafIsFile,
          active: leafIsFile && path === activePath,
          dirty: leafIsFile && editorDraftIsDirty(path),
        });
      }
    }
  }

  return [...entries.entries()]
    .sort(([leftPath], [rightPath]) =>
      leftPath === "."
        ? -1
        : rightPath === "."
          ? 1
          : leftPath.localeCompare(rightPath),
    )
    .map(([, item]) => item);
}

function languageFromPath(path: string): string {
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
  return "typescript";
}

function initialDraft(data: EditorFlowNode["data"], demoMode: boolean): EditorDraft {
  return getOrCreateEditorDraft(data.relativePath, {
    content: data.preview,
    savedContent: data.preview,
    ...(data.contentHash ? { contentHash: data.contentHash } : {}),
    language: data.language || languageFromPath(data.relativePath),
    loaded: demoMode,
    status: demoMode ? "idle" : "loading",
  });
}

export const EditorPanel = memo(function EditorPanel({
  id,
  data,
  height,
}: NodeProps<EditorFlowNode>) {
  const demoMode = useWorkspaceStore((state) => state.demoMode);
  const remoteHydrated = useWorkspaceStore((state) => state.remoteHydrated);
  const workspaceName = useWorkspaceStore((state) => state.workspaceName);
  const workspaceNodes = useWorkspaceStore((state) => state.nodes);
  const openFile = useWorkspaceStore((state) => state.openFile);
  const updateEditorPanel = useWorkspaceStore(
    (state) => state.updateEditorPanel,
  );
  const [draft, setDraft] = useState(() => initialDraft(data, demoMode));
  const pathRef = useRef(data.relativePath);
  const saveRef = useRef<() => Promise<void>>(async () => undefined);

  pathRef.current = data.relativePath;
  const dirty = draft.content !== draft.savedContent;
  const fileTree = useMemo(
    () =>
      demoMode
        ? demoFileTree
        : buildFileTree(workspaceNodes, workspaceName, data.relativePath),
    [
      data.relativePath,
      demoMode,
      draft.content,
      draft.savedContent,
      workspaceName,
      workspaceNodes,
    ],
  );

  const patchDraft = useCallback(
    (
      relativePath: string,
      patch: Partial<Omit<EditorDraft, "relativePath">>,
    ) => {
      const next = updateEditorDraft(relativePath, patch);
      if (pathRef.current === relativePath) setDraft(next);
      return next;
    },
    [],
  );

  useEffect(() => {
    let active = true;
    const relativePath = data.relativePath;
    const cached = initialDraft(data, demoMode);
    setDraft(cached);

    if (demoMode) return;
    if (!remoteHydrated) return;
    if (cached.loaded && cached.contentHash !== "demo") return;
    patchDraft(relativePath, { status: "loading" });

    void apiClient
      .readFile(relativePath)
      .then((file) => {
        if (!active) return;
        const language =
          file.language ?? languageFromPath(relativePath);
        patchDraft(relativePath, {
          content: file.content,
          savedContent: file.content,
          contentHash: file.contentHash,
          language,
          loaded: true,
          status: "idle",
        });
        updateEditorPanel({
          preview: file.content,
          contentHash: file.contentHash,
          language,
        });
      })
      .catch(() => {
        if (active) patchDraft(relativePath, { status: "error" });
      });
    return () => {
      active = false;
    };
  }, [
    data.relativePath,
    demoMode,
    patchDraft,
    remoteHydrated,
    updateEditorPanel,
  ]);

  const save = useCallback(async () => {
    const relativePath = pathRef.current;
    const current = getEditorDraft(relativePath);
    if (!current || current.status === "saving") return;
    if (demoMode) {
      patchDraft(relativePath, {
        savedContent: current.content,
        status: "saved",
      });
      return;
    }
    if (!current.contentHash) {
      patchDraft(relativePath, { status: "error" });
      return;
    }
    patchDraft(relativePath, { status: "saving" });
    try {
      const result = await apiClient.writeFile(
        relativePath,
        current.content,
        current.contentHash,
      );
      const latest = getEditorDraft(relativePath);
      const savedContent = latest?.content ?? current.content;
      patchDraft(relativePath, {
        contentHash: result.contentHash,
        savedContent,
        status: "saved",
      });
      updateEditorPanel({
        contentHash: result.contentHash,
        preview: savedContent,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message.toLowerCase() : "";
      patchDraft(relativePath, {
        status:
          message.includes("conflict") || message.includes("hash")
            ? "conflict"
            : "error",
      });
    }
  }, [demoMode, patchDraft, updateEditorPanel]);
  saveRef.current = save;

  const reloadFromDisk = useCallback(async () => {
    const relativePath = pathRef.current;
    patchDraft(relativePath, { status: "loading" });
    try {
      const file = await apiClient.readFile(relativePath);
      const language =
        file.language ?? languageFromPath(relativePath);
      patchDraft(relativePath, {
        content: file.content,
        savedContent: file.content,
        contentHash: file.contentHash,
        language,
        loaded: true,
        status: "idle",
      });
      updateEditorPanel({
        preview: file.content,
        contentHash: file.contentHash,
        language,
      });
    } catch {
      patchDraft(relativePath, { status: "error" });
    }
  }, [patchDraft, updateEditorPanel]);

  const overwriteDisk = useCallback(async () => {
    const relativePath = pathRef.current;
    const current = getEditorDraft(relativePath);
    if (!current) return;
    patchDraft(relativePath, { status: "saving" });
    try {
      const disk = await apiClient.readFile(relativePath);
      const result = await apiClient.writeFile(
        relativePath,
        current.content,
        disk.contentHash,
      );
      const latest = getEditorDraft(relativePath);
      const savedContent = latest?.content ?? current.content;
      patchDraft(relativePath, {
        savedContent,
        contentHash: result.contentHash,
        status: "saved",
      });
      updateEditorPanel({
        preview: savedContent,
        contentHash: result.contentHash,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message.toLowerCase() : "";
      patchDraft(relativePath, {
        status:
          message.includes("conflict") || message.includes("hash")
            ? "conflict"
            : "error",
      });
    }
  }, [patchDraft, updateEditorPanel]);

  const statusLabel =
    draft.status === "conflict"
      ? "Conflicto externo"
      : draft.status === "error"
        ? "Sin conexión"
        : draft.status === "loading"
          ? "Cargando"
          : draft.status === "saving"
            ? "Guardando"
            : dirty
              ? "Modificado"
              : draft.status === "saved"
                ? "Guardado"
                : "";

  return (
    <PanelFrame
      id={id}
      title={data.title}
      icon={<FileCode2 aria-hidden="true" size={14} />}
      minWidth={440}
      minHeight={300}
      currentHeight={height}
      collapsed={data.collapsed}
      expandedHeight={data.expandedHeight}
      accent="cyan"
      className="editor-panel"
      actions={
        <>
          <button
            type="button"
            aria-label="Guardar archivo"
            onClick={() => void save()}
            disabled={!dirty || draft.status === "loading" || draft.status === "saving"}
          >
            <Save aria-hidden="true" size={13} />
          </button>
          <button type="button" aria-label="Dividir editor">
            <SplitSquareVertical aria-hidden="true" size={13} />
          </button>
        </>
      }
    >
      <div className="editor-breadcrumbs">
        {data.relativePath.split("/").map((part, index, parts) => (
          <span key={`${part}-${index}`}>
            {part}
            {index < parts.length - 1 ? (
              <ChevronRight aria-hidden="true" size={11} />
            ) : null}
          </span>
        ))}
        <span
          className={`editor-save-status editor-save-status--${draft.status}`}
        >
          {statusLabel}
        </span>
      </div>
      {draft.status === "conflict" ? (
        <div className="editor-conflict" role="alert">
          <span>El archivo cambió fuera de Constelix. Tu borrador sigue intacto.</span>
          <div>
            <button type="button" onClick={() => void reloadFromDisk()}>
              <RefreshCcw aria-hidden="true" size={12} /> Recargar disco
            </button>
            <button
              className="editor-conflict-overwrite"
              type="button"
              onClick={() => void overwriteDisk()}
            >
              <Upload aria-hidden="true" size={12} /> Sobrescribir
            </button>
          </div>
        </div>
      ) : null}
      <div className="editor-workspace" data-testid="editor-panel">
        <aside className="file-tree" aria-label="Explorador de archivos">
          {fileTree.map((item, index) => (
            <button
              key={`${item.name}-${index}`}
              className={
                item.active
                  ? "file-tree-row file-tree-row--active"
                  : "file-tree-row"
              }
              type="button"
              style={{ paddingInlineStart: 8 + item.depth * 12 }}
              onClick={() =>
                item.type === "file" && item.relativePath
                  ? openFile(item.relativePath)
                  : undefined
              }
            >
              {item.type === "folder" ? (
                <>
                  {item.open ? (
                    <ChevronDown aria-hidden="true" size={11} />
                  ) : (
                    <ChevronRight aria-hidden="true" size={11} />
                  )}
                  {item.open ? (
                    <FolderOpen aria-hidden="true" size={13} />
                  ) : (
                    <Folder aria-hidden="true" size={13} />
                  )}
                </>
              ) : (
                <>
                  <span className="file-tree-spacer" />
                  <FileCode2 aria-hidden="true" size={12} />
                </>
              )}
              <span>{item.name}</span>
              {item.dirty ? (
                <span className="file-tree-dirty" aria-label="Borrador sin guardar">
                  •
                </span>
              ) : null}
            </button>
          ))}
        </aside>
        <div
          className="editor-code"
          aria-busy={draft.status === "loading"}
        >
          <Suspense
            fallback={
              <div className="panel-loading">
                <span /> Cargando editor…
              </div>
            }
          >
            <MonacoEditor
              key={`${data.relativePath}:${data.revealLine ?? 0}`}
              path={`file:///${data.relativePath}`}
              language={draft.language || languageFromPath(data.relativePath)}
              value={draft.content}
              onChange={(value) => {
                const nextStatus =
                  draft.status === "saved" ? "idle" : draft.status;
                patchDraft(data.relativePath, {
                  content: value ?? "",
                  status: nextStatus,
                });
              }}
              theme="constelix-dark"
              beforeMount={(monaco) => {
                monaco.editor.defineTheme("constelix-dark", {
                  base: "vs-dark",
                  inherit: true,
                  rules: [
                    { token: "comment", foreground: "72b86c" },
                    { token: "keyword", foreground: "c690e6" },
                    { token: "string", foreground: "d8b968" },
                    { token: "type.identifier", foreground: "64c7de" },
                  ],
                  colors: {
                    "editor.background": "#101618",
                    "editor.foreground": "#cbd5d7",
                    "editorLineNumber.foreground": "#566064",
                    "editorLineNumber.activeForeground": "#99a5a8",
                    "editor.lineHighlightBackground": "#182124",
                    "editorCursor.foreground": "#4ec8df",
                    "editor.selectionBackground": "#1e5565aa",
                    "editorIndentGuide.background1": "#263033",
                  },
                });
              }}
              onMount={(editor, monaco) => {
                editor.addCommand(
                  monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
                  () => void saveRef.current(),
                );
                if (data.revealLine) {
                  editor.setPosition({
                    lineNumber: data.revealLine,
                    column: 1,
                  });
                  editor.revealLineInCenter(data.revealLine);
                }
              }}
              options={{
                automaticLayout: true,
                fontFamily:
                  "SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                fontSize: 12,
                lineHeight: 20,
                minimap: { enabled: false },
                padding: { top: 10 },
                readOnly: draft.status === "loading",
                renderLineHighlight: "all",
                scrollBeyondLastLine: false,
                smoothScrolling: true,
                tabSize: 2,
                wordWrap: "off",
                overviewRulerBorder: false,
                fixedOverflowWidgets: true,
              }}
            />
          </Suspense>
        </div>
      </div>
      <footer className="editor-statusbar">
        <span>Ln 1, Col 1</span>
        <span>Espacios: 2</span>
        <span>UTF-8</span>
        <span>LF</span>
        <span>{draft.language}</span>
      </footer>
    </PanelFrame>
  );
});
