import { ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen, Save, SplitSquareVertical } from "lucide-react";
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NodeProps } from "@xyflow/react";

import { apiClient } from "../../lib/api";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import type { EditorFlowNode, WorkspaceNode } from "../../types";
import { PanelFrame } from "./PanelFrame";

const MonacoEditor = lazy(async () => {
  const [module] = await Promise.all([import("@monaco-editor/react"), import("../../lib/monaco")]);
  return { default: module.default };
});

interface FileTreeItem {
  depth: number;
  type: "folder" | "file";
  name: string;
  relativePath?: string;
  open?: boolean;
  active?: boolean;
}

const demoFileTree: FileTreeItem[] = [
  { depth: 0, type: "folder", name: "constelix", relativePath: ".", open: true },
  { depth: 1, type: "folder", name: ".git" },
  { depth: 1, type: "folder", name: "apps", open: true },
  { depth: 2, type: "folder", name: "local-agent", open: true },
  { depth: 3, type: "folder", name: "src", open: true },
  { depth: 4, type: "folder", name: "indexers", open: true },
  { depth: 5, type: "file", name: "GraphIndexer.ts", relativePath: "apps/local-agent/src/indexers/GraphIndexer.ts", active: true },
  { depth: 4, type: "folder", name: "utils" },
  { depth: 4, type: "folder", name: "types" },
  { depth: 3, type: "file", name: "index.ts", relativePath: "apps/local-agent/src/index.ts" },
  { depth: 2, type: "folder", name: "web" },
  { depth: 1, type: "folder", name: "packages" },
  { depth: 1, type: "file", name: ".gitignore", relativePath: ".gitignore" },
  { depth: 1, type: "file", name: "package.json", relativePath: "package.json" },
  { depth: 1, type: "file", name: "tsconfig.json", relativePath: "tsconfig.json" }
];

function buildFileTree(nodes: WorkspaceNode[], workspaceName: string, activePath: string): FileTreeItem[] {
  const entries = new Map<string, FileTreeItem>();
  entries.set(".", { depth: 0, type: "folder", name: workspaceName, relativePath: ".", open: true });

  for (const node of nodes) {
    if (node.type !== "semantic" || (node.data.kind !== "file" && node.data.kind !== "directory")) continue;
    const relativePath = node.data.relativePath;
    if (!relativePath || relativePath === ".") continue;
    const parts = relativePath.split("/").filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      const path = parts.slice(0, index + 1).join("/");
      const leafIsFile = index === parts.length - 1 && node.data.kind === "file";
      if (!entries.has(path) || leafIsFile) {
        entries.set(path, {
          depth: index + 1,
          type: leafIsFile ? "file" : "folder",
          name: parts[index]!,
          relativePath: path,
          open: !leafIsFile,
          active: leafIsFile && path === activePath
        });
      }
    }
  }

  return [...entries.entries()]
    .sort(([leftPath], [rightPath]) => leftPath === "." ? -1 : rightPath === "." ? 1 : leftPath.localeCompare(rightPath))
    .map(([, item]) => item);
}

function languageFromPath(path: string): string {
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
  return "typescript";
}

export const EditorPanel = memo(function EditorPanel({ id, data, height }: NodeProps<EditorFlowNode>) {
  const demoMode = useWorkspaceStore((state) => state.demoMode);
  const workspaceName = useWorkspaceStore((state) => state.workspaceName);
  const workspaceNodes = useWorkspaceStore((state) => state.nodes);
  const openFile = useWorkspaceStore((state) => state.openFile);
  const updateEditorPanel = useWorkspaceStore((state) => state.updateEditorPanel);
  const [content, setContent] = useState(data.preview);
  const [contentHash, setContentHash] = useState(data.contentHash);
  const [savedContent, setSavedContent] = useState(data.preview);
  const [status, setStatus] = useState<"idle" | "loading" | "saving" | "saved" | "conflict" | "error">("idle");
  const contentRef = useRef(content);
  const pathRef = useRef(data.relativePath);
  const saveRef = useRef<() => Promise<void>>(async () => undefined);

  contentRef.current = content;
  pathRef.current = data.relativePath;
  const dirty = content !== savedContent;
  const fileTree = useMemo(
    () => demoMode ? demoFileTree : buildFileTree(workspaceNodes, workspaceName, data.relativePath),
    [data.relativePath, demoMode, workspaceName, workspaceNodes]
  );

  useEffect(() => {
    let active = true;
    setStatus("loading");
    if (demoMode) {
      setContent(data.preview);
      setSavedContent(data.preview);
      setContentHash(data.contentHash);
      setStatus("idle");
      return;
    }

    void apiClient
      .readFile(data.relativePath)
      .then((file) => {
        if (!active) return;
        setContent(file.content);
        setSavedContent(file.content);
        setContentHash(file.contentHash);
        updateEditorPanel({ preview: file.content, contentHash: file.contentHash, language: file.language ?? languageFromPath(data.relativePath) });
        setStatus("idle");
      })
      .catch(() => {
        if (active) setStatus("error");
      });
    return () => {
      active = false;
    };
  }, [data.relativePath, data.preview, data.contentHash, demoMode, updateEditorPanel]);

  const save = useCallback(async () => {
    if (status === "saving") return;
    if (demoMode) {
      setSavedContent(contentRef.current);
      setStatus("saved");
      window.setTimeout(() => setStatus("idle"), 900);
      return;
    }
    setStatus("saving");
    try {
      const result = await apiClient.writeFile(pathRef.current, contentRef.current, contentHash);
      setContentHash(result.contentHash);
      setSavedContent(contentRef.current);
      updateEditorPanel({ contentHash: result.contentHash, preview: contentRef.current });
      setStatus("saved");
      window.setTimeout(() => setStatus("idle"), 900);
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      setStatus(message.includes("conflict") || message.includes("hash") ? "conflict" : "error");
    }
  }, [contentHash, demoMode, status, updateEditorPanel]);
  saveRef.current = save;

  return (
    <PanelFrame
      id={id}
      title={data.title}
      icon={<FileCode2 aria-hidden="true" size={14} />}
      minWidth={440}
      minHeight={300}
      currentHeight={height}
      accent="cyan"
      className="editor-panel"
      actions={
        <>
          <button type="button" aria-label="Guardar archivo" onClick={() => void save()} disabled={!dirty && status !== "conflict"}>
            <Save aria-hidden="true" size={13} />
          </button>
          <button type="button" aria-label="Dividir editor"><SplitSquareVertical aria-hidden="true" size={13} /></button>
        </>
      }
    >
      <div className="editor-breadcrumbs">
        {data.relativePath.split("/").map((part, index, parts) => (
          <span key={`${part}-${index}`}>{part}{index < parts.length - 1 ? <ChevronRight aria-hidden="true" size={11} /> : null}</span>
        ))}
        <span className={`editor-save-status editor-save-status--${status}`}>
          {dirty ? "Modificado" : status === "saved" ? "Guardado" : status === "conflict" ? "Conflicto externo" : status === "error" ? "Sin conexión" : ""}
        </span>
      </div>
      <div className="editor-workspace" data-testid="editor-panel">
        <aside className="file-tree" aria-label="Explorador de archivos">
          {fileTree.map((item, index) => (
            <button
              key={`${item.name}-${index}`}
              className={item.active ? "file-tree-row file-tree-row--active" : "file-tree-row"}
              type="button"
              style={{ paddingInlineStart: 8 + item.depth * 12 }}
              onClick={() => item.type === "file" && item.relativePath ? openFile(item.relativePath) : undefined}
            >
              {item.type === "folder" ? (
                <>
                  {item.open ? <ChevronDown aria-hidden="true" size={11} /> : <ChevronRight aria-hidden="true" size={11} />}
                  {item.open ? <FolderOpen aria-hidden="true" size={13} /> : <Folder aria-hidden="true" size={13} />}
                </>
              ) : (
                <><span className="file-tree-spacer" /><FileCode2 aria-hidden="true" size={12} /></>
              )}
              <span>{item.name}</span>
            </button>
          ))}
        </aside>
        <div className="editor-code" aria-busy={status === "loading"}>
          <Suspense fallback={<div className="panel-loading"><span /> Cargando editor…</div>}>
            <MonacoEditor
              key={`${data.relativePath}:${data.revealLine ?? 0}`}
              path={`file:///${data.relativePath}`}
              language={data.language || languageFromPath(data.relativePath)}
              value={content}
              onChange={(value) => setContent(value ?? "")}
              theme="constelix-dark"
              beforeMount={(monaco) => {
                monaco.editor.defineTheme("constelix-dark", {
                  base: "vs-dark",
                  inherit: true,
                  rules: [
                    { token: "comment", foreground: "72b86c" },
                    { token: "keyword", foreground: "c690e6" },
                    { token: "string", foreground: "d8b968" },
                    { token: "type.identifier", foreground: "64c7de" }
                  ],
                  colors: {
                    "editor.background": "#101618",
                    "editor.foreground": "#cbd5d7",
                    "editorLineNumber.foreground": "#566064",
                    "editorLineNumber.activeForeground": "#99a5a8",
                    "editor.lineHighlightBackground": "#182124",
                    "editorCursor.foreground": "#4ec8df",
                    "editor.selectionBackground": "#1e5565aa",
                    "editorIndentGuide.background1": "#263033"
                  }
                });
              }}
              onMount={(editor, monaco) => {
                editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current());
                if (data.revealLine) {
                  editor.setPosition({ lineNumber: data.revealLine, column: 1 });
                  editor.revealLineInCenter(data.revealLine);
                }
              }}
              options={{
                automaticLayout: true,
                fontFamily: "SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                fontSize: 12,
                lineHeight: 20,
                minimap: { enabled: false },
                padding: { top: 10 },
                renderLineHighlight: "all",
                scrollBeyondLastLine: false,
                smoothScrolling: true,
                tabSize: 2,
                wordWrap: "off",
                overviewRulerBorder: false,
                fixedOverflowWidgets: true
              }}
            />
          </Suspense>
        </div>
      </div>
      <footer className="editor-statusbar">
        <span>Ln 14, Col 3</span><span>Espacios: 2</span><span>UTF-8</span><span>LF</span><span>{data.language}</span>
      </footer>
    </PanelFrame>
  );
});
