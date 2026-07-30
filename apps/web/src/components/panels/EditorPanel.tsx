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

import { AgentRequestError, apiClient } from "../../lib/api";
import {
  editorDraftIsDirty,
  getEditorDraft,
  getOrCreateEditorDraft,
  markEditorDraftPersisted,
  updateEditorDraft,
  type EditorDraft,
} from "../../lib/editorDrafts";
import {
  attachMonacoLspDocument,
  configureMonacoLsp,
  constelixDocumentUri,
  type LspDocumentStatus,
  type MonacoLspDocument,
} from "../../lib/lsp";
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
  workspaceId: string,
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
          dirty:
            leafIsFile && editorDraftIsDirty(workspaceId, path),
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

function initialDraft(
  workspaceId: string,
  data: EditorFlowNode["data"],
  demoMode: boolean,
): EditorDraft {
  return getOrCreateEditorDraft(workspaceId, data.relativePath, {
    content: data.preview,
    savedContent: data.preview,
    ...(data.contentHash ? { contentHash: data.contentHash } : {}),
    language: data.language || languageFromPath(data.relativePath),
    loaded: demoMode,
    status: demoMode ? "idle" : "loading",
  });
}

type EditorPanelProps = Pick<
  NodeProps<EditorFlowNode>,
  "id" | "data" | "height"
> & { docked?: boolean };

export const EditorPanel = memo(function EditorPanel({
  id,
  data,
  height,
  docked = false,
}: EditorPanelProps) {
  const demoMode = useWorkspaceStore((state) => state.demoMode);
  const remoteHydrated = useWorkspaceStore((state) => state.remoteHydrated);
  const connection = useWorkspaceStore((state) => state.connection);
  const workspaceId = useWorkspaceStore((state) => state.workspaceId);
  const workspaceMode = useWorkspaceStore((state) => state.workspaceMode);
  const workspaceName = useWorkspaceStore((state) => state.workspaceName);
  const semanticVersion = useWorkspaceStore((state) => state.semanticVersion);
  const openFile = useWorkspaceStore((state) => state.openFile);
  const updateEditorPanel = useWorkspaceStore(
    (state) => state.updateEditorPanel,
  );
  const [draft, setDraft] = useState(() =>
    initialDraft(workspaceId, data, demoMode),
  );
  const [lspStatus, setLspStatus] =
    useState<LspDocumentStatus>("connecting");
  const [diagnosticCount, setDiagnosticCount] = useState(0);
  const lspDocumentRef = useRef<MonacoLspDocument | null>(null);
  const pathRef = useRef(data.relativePath);
  const saveRef = useRef<() => Promise<void>>(async () => undefined);

  pathRef.current = data.relativePath;
  const dirty = draft.content !== draft.savedContent;
  const fileTree = useMemo(
    () =>
      demoMode
        ? demoFileTree
        : buildFileTree(
            useWorkspaceStore.getState().nodes,
            workspaceId,
            workspaceName,
            data.relativePath,
          ),
    [
      data.relativePath,
      demoMode,
      draft.content,
      draft.savedContent,
      semanticVersion,
      workspaceId,
      workspaceName,
    ],
  );

  useEffect(() => () => {
    lspDocumentRef.current?.dispose();
    lspDocumentRef.current = null;
  }, [data.relativePath, workspaceId]);

  const patchDraft = useCallback(
    (
      relativePath: string,
      patch: Partial<Omit<EditorDraft, "workspaceId" | "relativePath">>,
    ) => {
      const next = updateEditorDraft(workspaceId, relativePath, patch);
      if (pathRef.current === relativePath) setDraft(next);
      return next;
    },
    [workspaceId],
  );

  useEffect(() => {
    let active = true;
    const relativePath = data.relativePath;
    const cached = initialDraft(workspaceId, data, demoMode);
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
        if (active) {
          patchDraft(relativePath, {
            status: "error",
            errorMessage: "No se pudo leer el archivo desde el agente local.",
          });
        }
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
    workspaceId,
  ]);

  const save = useCallback(async () => {
    const relativePath = pathRef.current;
    const current = getEditorDraft(workspaceId, relativePath);
    if (!current || current.status === "saving") return;
    if (!demoMode && (!remoteHydrated || connection !== "connected")) {
      patchDraft(relativePath, {
        status: "error",
        errorMessage:
          "Espera a que termine la reconciliación del workspace antes de guardar.",
      });
      return;
    }
    if (workspaceMode === "read") {
      patchDraft(relativePath, {
        status: "error",
        errorMessage: "El workspace está abierto en Modo Lectura.",
      });
      return;
    }
    if (demoMode) {
      patchDraft(relativePath, {
        savedContent: current.content,
        status: "saved",
      });
      return;
    }
    if (!current.contentHash) {
      patchDraft(relativePath, {
        status: "error",
        errorMessage: "No se puede guardar sin una versión base del archivo.",
      });
      return;
    }
    patchDraft(relativePath, { status: "saving" });
    try {
      const result = await apiClient.writeFile(
        relativePath,
        current.content,
        current.contentHash,
      );
      const latest = getEditorDraft(workspaceId, relativePath);
      const persisted = markEditorDraftPersisted(
        workspaceId,
        relativePath,
        current.content,
        result.contentHash,
      );
      if (pathRef.current === relativePath) {
        setDraft(persisted);
        updateEditorPanel({
          contentHash: result.contentHash,
          preview: latest?.content ?? current.content,
        });
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message.toLowerCase() : "";
      const conflict =
        (error instanceof AgentRequestError &&
          error.code === "FILE_CONFLICT") ||
        message.includes("conflict") ||
        message.includes("hash") ||
        message.includes("changed on disk");
      patchDraft(relativePath, {
        status: conflict ? "conflict" : "error",
        errorMessage:
          error instanceof Error ? error.message : "No se pudo guardar.",
      });
    }
  }, [
    demoMode,
    connection,
    patchDraft,
    remoteHydrated,
    updateEditorPanel,
    workspaceId,
    workspaceMode,
  ]);
  saveRef.current = save;

  const reloadFromDisk = useCallback(async () => {
    const relativePath = pathRef.current;
    if (!demoMode && (!remoteHydrated || connection !== "connected")) {
      return;
    }
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
      patchDraft(relativePath, {
        status: "error",
        errorMessage: "No se pudo recargar el archivo.",
      });
    }
  }, [
    connection,
    demoMode,
    patchDraft,
    remoteHydrated,
    updateEditorPanel,
  ]);

  const overwriteDisk = useCallback(async () => {
    const relativePath = pathRef.current;
    const current = getEditorDraft(workspaceId, relativePath);
    if (!current) return;
    if (workspaceMode === "read") return;
    if (!demoMode && (!remoteHydrated || connection !== "connected")) {
      return;
    }
    patchDraft(relativePath, { status: "saving" });
    try {
      const disk = await apiClient.readFile(relativePath);
      const result = await apiClient.writeFile(
        relativePath,
        current.content,
        disk.contentHash,
      );
      const latest = getEditorDraft(workspaceId, relativePath);
      const persisted = markEditorDraftPersisted(
        workspaceId,
        relativePath,
        current.content,
        result.contentHash,
      );
      if (pathRef.current === relativePath) {
        setDraft(persisted);
        updateEditorPanel({
          preview: latest?.content ?? current.content,
          contentHash: result.contentHash,
        });
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message.toLowerCase() : "";
      patchDraft(relativePath, {
        status:
          message.includes("conflict") || message.includes("hash")
            ? "conflict"
            : "error",
        errorMessage:
          error instanceof Error ? error.message : "No se pudo sobrescribir.",
      });
    }
  }, [
    connection,
    demoMode,
    patchDraft,
    remoteHydrated,
    updateEditorPanel,
    workspaceId,
    workspaceMode,
  ]);

  const statusLabel =
    workspaceMode === "read"
      ? "Solo lectura"
      : draft.status === "conflict"
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
      docked={docked}
      dockTarget="right"
      actions={
        <>
          <button
            type="button"
            aria-label="Guardar archivo"
            onClick={() => void save()}
            disabled={
              workspaceMode === "read" ||
              (!demoMode &&
                (!remoteHydrated || connection !== "connected")) ||
              !dirty ||
              draft.status === "loading" ||
              draft.status === "saving"
            }
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
            {workspaceMode === "edit" ? (
              <button
                className="editor-conflict-overwrite"
                type="button"
                onClick={() => void overwriteDisk()}
              >
                <Upload aria-hidden="true" size={12} /> Sobrescribir
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {draft.status === "error" && draft.errorMessage ? (
        <div className="editor-operation-error" role="alert">
          {draft.errorMessage}
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
              key={`${workspaceId}:${data.relativePath}:${data.revealLine ?? 0}`}
              path={constelixDocumentUri(workspaceId, data.relativePath)}
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
                configureMonacoLsp(
                  monaco,
                  (relativePath, line, column) => {
                    const workspace = useWorkspaceStore.getState();
                    workspace.openFile(relativePath);
                    workspace.updateEditorPanel({
                      revealLine: line,
                      revealColumn: column,
                    });
                  },
                );
                lspDocumentRef.current?.dispose();
                lspDocumentRef.current = attachMonacoLspDocument(
                  monaco,
                  editor.getModel()!,
                  draft.language || languageFromPath(data.relativePath),
                  {
                    status: setLspStatus,
                    diagnostics: (_uri, diagnostics) => {
                      setDiagnosticCount(diagnostics.length);
                    },
                  },
                );
                editor.addCommand(
                  monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
                  () => void saveRef.current(),
                );
                if (data.revealLine) {
                  editor.setPosition({
                    lineNumber: data.revealLine,
                    column: data.revealColumn ?? 1,
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
                readOnly:
                  workspaceMode === "read" || draft.status === "loading",
                readOnlyMessage: {
                  value:
                    workspaceMode === "read"
                      ? "Constelix abrió este workspace en Modo Lectura."
                      : "El archivo todavía está cargando.",
                },
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
        <span
          className={`editor-lsp-status editor-lsp-status--${lspStatus}`}
          title="Estado del servidor de lenguaje local"
        >
          LSP {lspStatusLabel(lspStatus)}
          {diagnosticCount ? ` · ${diagnosticCount}` : ""}
        </span>
      </footer>
    </PanelFrame>
  );
});

function lspStatusLabel(status: LspDocumentStatus): string {
  if (status === "ready") return "listo";
  if (status === "connecting") return "conectando";
  if (status === "error") return "con error";
  return "no disponible";
}
