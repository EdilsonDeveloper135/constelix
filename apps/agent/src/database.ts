import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  GraphDelta,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  PanelState,
} from "@constelix/contracts";
import {
  sanitizeGraphDelta,
  sanitizeGraphSnapshot,
  sanitizeUnknownStrings,
} from "@constelix/contracts";

export interface IndexedFileRecord {
  relativePath: string;
  contentHash: string;
  sizeBytes: number;
  mtimeMs: number;
  language: string;
}

export interface IncrementalFileChanges {
  upsert?: readonly IndexedFileRecord[];
  removedPaths?: readonly string[];
}

const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    canonical_root TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_opened_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS files (
    workspace_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    language TEXT,
    indexed_revision INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, relative_path),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS graph_nodes (
    workspace_id TEXT NOT NULL,
    id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (workspace_id, id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS graph_edges (
    workspace_id TEXT NOT NULL,
    id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (workspace_id, id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS index_revisions (
    workspace_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    diagnostics_json TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (workspace_id, revision),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS layouts (
    workspace_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    panels_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS ai_threads (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS ai_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    evidence_json TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES ai_threads(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS codex_threads (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    codex_thread_id TEXT,
    status TEXT NOT NULL,
    task_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    category TEXT NOT NULL,
    action TEXT NOT NULL,
    outcome TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS graph_search USING fts5(
    workspace_id UNINDEXED,
    node_id UNINDEXED,
    name,
    qualified_name,
    relative_path,
    documentation
  );
  CREATE INDEX IF NOT EXISTS graph_nodes_workspace_revision
    ON graph_nodes(workspace_id, revision);
  CREATE INDEX IF NOT EXISTS graph_edges_workspace_revision
    ON graph_edges(workspace_id, revision);
  CREATE INDEX IF NOT EXISTS audit_workspace_created
    ON audit_events(workspace_id, created_at);
  `,
] as const;

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export class ConstelixDatabase {
  readonly raw: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.raw = new Database(path);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("foreign_keys = ON");
    this.raw.pragma("busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`,
    );
    const current = this.raw
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as { version: number };
    for (let index = current.version; index < MIGRATIONS.length; index += 1) {
      const migration = MIGRATIONS[index];
      if (!migration) continue;
      this.raw.transaction(() => {
        this.raw.exec(migration);
        this.raw
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(index + 1, new Date().toISOString());
      })();
    }
  }

  upsertWorkspace(id: string, canonicalRoot: string): void {
    const now = new Date().toISOString();
    this.raw
      .prepare(
        `INSERT INTO workspaces(id, canonical_root, created_at, last_opened_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET canonical_root=excluded.canonical_root,
           last_opened_at=excluded.last_opened_at`,
      )
      .run(id, canonicalRoot, now, now);
  }

  replaceGraph(workspaceId: string, snapshot: GraphSnapshot, diagnostics: unknown[] = []): void {
    const safeSnapshot = sanitizeGraphSnapshot(snapshot);
    const safeDiagnostics = sanitizeUnknownStrings(diagnostics);
    const revision = safeSnapshot.revision;
    const insertNode = this.raw.prepare(
      "INSERT INTO graph_nodes(workspace_id,id,revision,data_json) VALUES (?,?,?,?)",
    );
    const insertEdge = this.raw.prepare(
      "INSERT INTO graph_edges(workspace_id,id,revision,data_json) VALUES (?,?,?,?)",
    );
    const insertSearch = this.raw.prepare(
      `INSERT INTO graph_search(workspace_id,node_id,name,qualified_name,relative_path,documentation)
       VALUES (?,?,?,?,?,?)`,
    );

    this.raw.transaction(() => {
      this.raw.prepare("DELETE FROM graph_nodes WHERE workspace_id = ?").run(workspaceId);
      this.raw.prepare("DELETE FROM graph_edges WHERE workspace_id = ?").run(workspaceId);
      this.raw.prepare("DELETE FROM graph_search WHERE workspace_id = ?").run(workspaceId);
      for (const node of safeSnapshot.nodes) {
        insertNode.run(workspaceId, node.id, revision, json(node));
        const record = node as GraphNode & { documentation?: string };
        insertSearch.run(
          workspaceId,
          node.id,
          node.name,
          node.qualifiedName ?? "",
          node.relativePath ?? "",
          record.documentation ?? "",
        );
      }
      for (const edge of safeSnapshot.edges) {
        insertEdge.run(workspaceId, edge.id, revision, json(edge));
      }
      this.raw
        .prepare(
          `INSERT OR REPLACE INTO index_revisions(workspace_id,revision,created_at,diagnostics_json)
           VALUES (?,?,?,?)`,
        )
        .run(workspaceId, revision, new Date().toISOString(), json(safeDiagnostics));
    })();
  }

  /** Replaces one complete graph revision and its file manifest in one transaction. */
  replaceIndexRevision(
    workspaceId: string,
    snapshot: GraphSnapshot,
    files: readonly IndexedFileRecord[],
    diagnostics: unknown[] = [],
  ): void {
    const safeSnapshot = sanitizeGraphSnapshot(snapshot);
    const safeDiagnostics = sanitizeUnknownStrings(diagnostics);
    const revision = safeSnapshot.revision;
    const insertNode = this.raw.prepare(
      "INSERT INTO graph_nodes(workspace_id,id,revision,data_json) VALUES (?,?,?,?)",
    );
    const insertEdge = this.raw.prepare(
      "INSERT INTO graph_edges(workspace_id,id,revision,data_json) VALUES (?,?,?,?)",
    );
    const insertSearch = this.raw.prepare(
      `INSERT INTO graph_search(workspace_id,node_id,name,qualified_name,relative_path,documentation)
       VALUES (?,?,?,?,?,?)`,
    );
    const insertFile = this.raw.prepare(
      `INSERT INTO files(workspace_id,relative_path,content_hash,size_bytes,mtime_ms,language,indexed_revision)
       VALUES (?,?,?,?,?,?,?)`,
    );

    this.raw.transaction(() => {
      this.raw.prepare("DELETE FROM graph_nodes WHERE workspace_id = ?").run(workspaceId);
      this.raw.prepare("DELETE FROM graph_edges WHERE workspace_id = ?").run(workspaceId);
      this.raw.prepare("DELETE FROM graph_search WHERE workspace_id = ?").run(workspaceId);
      this.raw.prepare("DELETE FROM files WHERE workspace_id = ?").run(workspaceId);

      for (const node of safeSnapshot.nodes) {
        insertNode.run(workspaceId, node.id, revision, json(node));
        const record = node as GraphNode & { documentation?: string };
        insertSearch.run(
          workspaceId,
          node.id,
          node.name,
          node.qualifiedName ?? "",
          node.relativePath ?? "",
          record.documentation ?? "",
        );
      }
      for (const edge of safeSnapshot.edges) {
        insertEdge.run(workspaceId, edge.id, revision, json(edge));
      }
      for (const file of files) {
        insertFile.run(
          workspaceId,
          file.relativePath,
          file.contentHash,
          file.sizeBytes,
          file.mtimeMs,
          file.language,
          revision,
        );
      }
      this.raw
        .prepare(
          `INSERT OR REPLACE INTO index_revisions(workspace_id,revision,created_at,diagnostics_json)
           VALUES (?,?,?,?)`,
        )
        .run(workspaceId, revision, new Date().toISOString(), json(safeDiagnostics));
    })();
  }

  replaceFiles(workspaceId: string, revision: number, files: readonly IndexedFileRecord[]): void {
    const insert = this.raw.prepare(
      `INSERT INTO files(workspace_id,relative_path,content_hash,size_bytes,mtime_ms,language,indexed_revision)
       VALUES (?,?,?,?,?,?,?)`,
    );
    this.raw.transaction(() => {
      this.raw.prepare("DELETE FROM files WHERE workspace_id = ?").run(workspaceId);
      for (const file of files) {
        insert.run(
          workspaceId,
          file.relativePath,
          file.contentHash,
          file.sizeBytes,
          file.mtimeMs,
          file.language,
          revision,
        );
      }
    })();
  }

  /**
   * Applies one incremental graph revision and its file metadata atomically.
   * Unchanged graph rows are deliberately left untouched so a single edit does
   * not turn into an O(workspace) SQLite rewrite.
   */
  applyGraphDelta(
    workspaceId: string,
    delta: GraphDelta,
    fileChanges: IncrementalFileChanges = {},
    diagnostics: unknown[] = [],
  ): void {
    const safeDelta = sanitizeGraphDelta(delta);
    const safeDiagnostics = sanitizeUnknownStrings(diagnostics);
    if (safeDelta.workspaceId !== workspaceId) {
      throw new Error("Graph delta belongs to another workspace.");
    }
    if (safeDelta.revision <= safeDelta.previousRevision) {
      throw new Error("Graph delta revision must advance.");
    }
    const currentRevision = this.raw
      .prepare("SELECT MAX(revision) AS revision FROM index_revisions WHERE workspace_id = ?")
      .get(workspaceId) as { revision: number | null };
    if (currentRevision.revision !== safeDelta.previousRevision) {
      throw new Error(
        `Graph revision mismatch: expected ${currentRevision.revision ?? 0}, received ${safeDelta.previousRevision}.`,
      );
    }

    const deleteNode = this.raw.prepare(
      "DELETE FROM graph_nodes WHERE workspace_id = ? AND id = ?",
    );
    const deleteEdge = this.raw.prepare(
      "DELETE FROM graph_edges WHERE workspace_id = ? AND id = ?",
    );
    const deleteSearch = this.raw.prepare(
      "DELETE FROM graph_search WHERE workspace_id = ? AND node_id = ?",
    );
    const upsertNode = this.raw.prepare(
      `INSERT INTO graph_nodes(workspace_id,id,revision,data_json) VALUES (?,?,?,?)
       ON CONFLICT(workspace_id,id) DO UPDATE SET
         revision=excluded.revision,data_json=excluded.data_json`,
    );
    const upsertEdge = this.raw.prepare(
      `INSERT INTO graph_edges(workspace_id,id,revision,data_json) VALUES (?,?,?,?)
       ON CONFLICT(workspace_id,id) DO UPDATE SET
         revision=excluded.revision,data_json=excluded.data_json`,
    );
    const insertSearch = this.raw.prepare(
      `INSERT INTO graph_search(workspace_id,node_id,name,qualified_name,relative_path,documentation)
       VALUES (?,?,?,?,?,?)`,
    );
    const deleteFile = this.raw.prepare(
      "DELETE FROM files WHERE workspace_id = ? AND relative_path = ?",
    );
    const upsertFile = this.raw.prepare(
      `INSERT INTO files(workspace_id,relative_path,content_hash,size_bytes,mtime_ms,language,indexed_revision)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(workspace_id,relative_path) DO UPDATE SET
         content_hash=excluded.content_hash,
         size_bytes=excluded.size_bytes,
         mtime_ms=excluded.mtime_ms,
         language=excluded.language,
         indexed_revision=excluded.indexed_revision`,
    );

    this.raw.transaction(() => {
      for (const edgeId of safeDelta.edgeIdsRemoved) deleteEdge.run(workspaceId, edgeId);
      for (const nodeId of safeDelta.nodeIdsRemoved) {
        deleteSearch.run(workspaceId, nodeId);
        deleteNode.run(workspaceId, nodeId);
      }

      for (const node of [...safeDelta.nodesAdded, ...safeDelta.nodesUpdated]) {
        upsertNode.run(workspaceId, node.id, safeDelta.revision, json(node));
        deleteSearch.run(workspaceId, node.id);
        const record = node as GraphNode & { documentation?: string };
        insertSearch.run(
          workspaceId,
          node.id,
          node.name,
          node.qualifiedName ?? "",
          node.relativePath ?? "",
          record.documentation ?? "",
        );
      }
      for (const edge of [...safeDelta.edgesAdded, ...safeDelta.edgesUpdated]) {
        upsertEdge.run(workspaceId, edge.id, safeDelta.revision, json(edge));
      }

      for (const relativePath of fileChanges.removedPaths ?? []) {
        deleteFile.run(workspaceId, relativePath);
      }
      for (const file of fileChanges.upsert ?? []) {
        upsertFile.run(
          workspaceId,
          file.relativePath,
          file.contentHash,
          file.sizeBytes,
          file.mtimeMs,
          file.language,
          safeDelta.revision,
        );
      }

      this.raw
        .prepare(
          `INSERT INTO index_revisions(workspace_id,revision,created_at,diagnostics_json)
           VALUES (?,?,?,?)`,
        )
        .run(
          workspaceId,
          safeDelta.revision,
          new Date().toISOString(),
          json(safeDiagnostics),
        );
    })();
  }

  loadGraph(workspaceId: string): GraphSnapshot | undefined {
    const revisionRow = this.raw
      .prepare("SELECT MAX(revision) AS revision FROM index_revisions WHERE workspace_id = ?")
      .get(workspaceId) as { revision: number | null };
    if (revisionRow.revision === null) return undefined;
    const nodes = this.raw
      .prepare("SELECT data_json FROM graph_nodes WHERE workspace_id = ?")
      .all(workspaceId) as Array<{ data_json: string }>;
    const edges = this.raw
      .prepare("SELECT data_json FROM graph_edges WHERE workspace_id = ?")
      .all(workspaceId) as Array<{ data_json: string }>;
    return sanitizeGraphSnapshot({
      protocolVersion: 1,
      workspaceId,
      revision: revisionRow.revision,
      nodes: nodes.map((row) => parseJson<GraphNode>(row.data_json)),
      edges: edges.map((row) => parseJson<GraphEdge>(row.data_json)),
      truncated: false,
    });
  }

  loadFiles(workspaceId: string): IndexedFileRecord[] {
    return this.raw
      .prepare(
        `SELECT relative_path,content_hash,size_bytes,mtime_ms,language
         FROM files WHERE workspace_id = ? ORDER BY relative_path`,
      )
      .all(workspaceId)
      .map((row) => {
        const record = row as {
          relative_path: string;
          content_hash: string;
          size_bytes: number;
          mtime_ms: number;
          language: string | null;
        };
        return {
          relativePath: record.relative_path,
          contentHash: record.content_hash,
          sizeBytes: record.size_bytes,
          mtimeMs: record.mtime_ms,
          language: record.language ?? "unknown",
        };
      });
  }

  saveLayout(workspaceId: string, revision: number, panels: PanelState[]): void {
    this.raw
      .prepare(
        `INSERT INTO layouts(workspace_id,revision,panels_json,updated_at) VALUES (?,?,?,?)
         ON CONFLICT(workspace_id) DO UPDATE SET revision=excluded.revision,
           panels_json=excluded.panels_json,updated_at=excluded.updated_at`,
      )
      .run(workspaceId, revision, json(panels), new Date().toISOString());
  }

  loadLayout(workspaceId: string): { revision: number; panels: PanelState[] } | undefined {
    const row = this.raw
      .prepare("SELECT revision,panels_json FROM layouts WHERE workspace_id = ?")
      .get(workspaceId) as { revision: number; panels_json: string } | undefined;
    if (!row) return undefined;
    return { revision: row.revision, panels: parseJson<PanelState[]>(row.panels_json) };
  }

  appendAiMessage(
    workspaceId: string,
    threadId: string,
    message: { id: string; role: "user" | "assistant"; content: string; evidence?: unknown },
  ): void {
    const now = new Date().toISOString();
    this.raw.transaction(() => {
      this.raw
        .prepare(
          `INSERT INTO ai_threads(id,workspace_id,created_at,updated_at) VALUES (?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at`,
        )
        .run(threadId, workspaceId, now, now);
      this.raw
        .prepare(
          `INSERT OR REPLACE INTO ai_messages(id,thread_id,role,content,evidence_json,created_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(
          message.id,
          threadId,
          message.role,
          message.content,
          message.evidence === undefined ? null : json(message.evidence),
          now,
        );
    })();
  }

  loadAiMessages(threadId: string): Array<{ role: "user" | "assistant"; content: string; evidence?: unknown }> {
    const rows = this.raw
      .prepare(
        `SELECT role,content,evidence_json
         FROM ai_messages
         WHERE thread_id = ?
         ORDER BY created_at,rowid`,
      )
      .all(threadId) as Array<{ role: "user" | "assistant"; content: string; evidence_json: string | null }>;
    return rows.map((row) => ({
      role: row.role,
      content: row.content,
      ...(row.evidence_json === null ? {} : { evidence: parseJson(row.evidence_json) })
    }));
  }

  saveCodexTask(
    workspaceId: string,
    task: { id: string; codexThreadId?: string; status: string; [key: string]: unknown },
  ): void {
    const now = new Date().toISOString();
    this.raw
      .prepare(
        `INSERT INTO codex_threads(id,workspace_id,codex_thread_id,status,task_json,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET codex_thread_id=excluded.codex_thread_id,
           status=excluded.status,task_json=excluded.task_json,updated_at=excluded.updated_at`,
      )
      .run(
        task.id,
        workspaceId,
        task.codexThreadId ?? null,
        task.status,
        json(task),
        now,
        now,
      );
  }

  audit(
    workspaceId: string,
    category: string,
    action: string,
    outcome: string,
    details: unknown = {},
  ): void {
    this.raw
      .prepare(
        `INSERT INTO audit_events(workspace_id,category,action,outcome,details_json,created_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(workspaceId, category, action, outcome, json(details), new Date().toISOString());
  }

  search(workspaceId: string, text: string, limit = 20): string[] {
    const safeLimit = Math.min(Math.max(limit, 1), 120);
    const rows = this.raw
      .prepare(
        `SELECT node_id FROM graph_search WHERE workspace_id = ? AND graph_search MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(workspaceId, text.replace(/["']/g, " ").trim(), safeLimit) as Array<{
      node_id: string;
    }>;
    return rows.map((row) => row.node_id);
  }

  close(): void {
    this.raw.close();
  }
}
