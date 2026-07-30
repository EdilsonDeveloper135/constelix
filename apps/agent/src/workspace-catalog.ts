import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, normalize } from "node:path";

import { summarizeWorkspacePath } from "./security.js";

export const MAX_RECENT_WORKSPACES = 12;

export type WorkspaceCatalogMode = "read" | "edit";

export interface WorkspaceCatalogOptions {
  now?: () => Date;
  userHome?: string;
}

export interface RecordOpenedWorkspaceInput {
  workspaceId: string;
  canonicalRoot: string;
  mode: WorkspaceCatalogMode;
  name?: string;
}

export interface RecentWorkspace {
  workspaceId: string;
  name: string;
  displayPath: string;
  lastOpenedAt: string;
  mode: WorkspaceCatalogMode;
}

/**
 * Server-only catalog record. `canonicalRoot` must never be copied into the
 * public recent-workspace payload.
 */
export interface WorkspaceCatalogRecord extends RecentWorkspace {
  canonicalRoot: string;
}

interface WorkspaceCatalogRow {
  workspace_id: string;
  canonical_root: string;
  display_name: string;
  display_path: string;
  last_opened_at: string;
  mode: WorkspaceCatalogMode;
}

const CATALOG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS recent_workspaces (
    workspace_id TEXT PRIMARY KEY,
    canonical_root TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    display_path TEXT NOT NULL,
    last_opened_at TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('read', 'edit')),
    opened_order INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS recent_workspaces_last_opened
    ON recent_workspaces(last_opened_at DESC, opened_order DESC);
`;

export class WorkspaceCatalog {
  private readonly raw: Database.Database;
  private readonly now: () => Date;
  private readonly userHome: string | undefined;
  private closed = false;

  constructor(path: string, options: WorkspaceCatalogOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.userHome = options.userHome;
    if (path !== ":memory:") {
      const parentDirectory = dirname(path);
      const createdDirectory = mkdirSync(parentDirectory, {
        recursive: true,
        mode: 0o700,
      });
      if (createdDirectory !== undefined) {
        chmodSync(parentDirectory, 0o700);
      }
    }
    this.raw = new Database(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("busy_timeout = 5000");
    this.raw.exec(CATALOG_SCHEMA);
  }

  recordOpenedWorkspace(input: RecordOpenedWorkspaceInput): RecentWorkspace {
    this.assertOpen();
    const workspaceId = validateWorkspaceId(input.workspaceId);
    const canonicalRoot = validateCanonicalRoot(input.canonicalRoot);
    const name = validateDisplayName(input.name ?? basename(canonicalRoot));
    const displayPath = this.userHome === undefined
      ? summarizeWorkspacePath(canonicalRoot)
      : summarizeWorkspacePath(canonicalRoot, this.userHome);
    const lastOpenedAt = this.now().toISOString();

    this.raw.transaction(() => {
      const order = this.raw
        .prepare(
          "SELECT COALESCE(MAX(opened_order), 0) + 1 AS opened_order FROM recent_workspaces",
        )
        .get() as { opened_order: number };
      this.raw
        .prepare(
          `DELETE FROM recent_workspaces
           WHERE canonical_root = ? AND workspace_id <> ?`,
        )
        .run(canonicalRoot, workspaceId);
      this.raw
        .prepare(
          `INSERT INTO recent_workspaces(
             workspace_id, canonical_root, display_name, display_path,
             last_opened_at, mode, opened_order
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(workspace_id) DO UPDATE SET
             canonical_root=excluded.canonical_root,
             display_name=excluded.display_name,
             display_path=excluded.display_path,
             last_opened_at=excluded.last_opened_at,
             mode=excluded.mode,
             opened_order=excluded.opened_order`,
        )
        .run(
          workspaceId,
          canonicalRoot,
          name,
          displayPath,
          lastOpenedAt,
          input.mode,
          order.opened_order,
        );
      this.raw
        .prepare(
          `DELETE FROM recent_workspaces
           WHERE workspace_id IN (
             SELECT workspace_id
             FROM recent_workspaces
             ORDER BY last_opened_at DESC, opened_order DESC, workspace_id
             LIMIT -1 OFFSET ?
           )`,
        )
        .run(MAX_RECENT_WORKSPACES);
    })();

    return { workspaceId, name, displayPath, lastOpenedAt, mode: input.mode };
  }

  listRecentWorkspaces(limit = MAX_RECENT_WORKSPACES): RecentWorkspace[] {
    this.assertOpen();
    const safeLimit = Math.min(
      Math.max(Number.isSafeInteger(limit) ? limit : MAX_RECENT_WORKSPACES, 0),
      MAX_RECENT_WORKSPACES,
    );
    if (safeLimit === 0) return [];
    const rows = this.raw
      .prepare(
        `SELECT workspace_id, canonical_root, display_name, display_path,
                last_opened_at, mode
         FROM recent_workspaces
         ORDER BY last_opened_at DESC, opened_order DESC, workspace_id
         LIMIT ?`,
      )
      .all(safeLimit) as WorkspaceCatalogRow[];
    return rows.map(toRecentWorkspace);
  }

  lookupWorkspace(workspaceId: string): WorkspaceCatalogRecord | undefined {
    this.assertOpen();
    const row = this.raw
      .prepare(
        `SELECT workspace_id, canonical_root, display_name, display_path,
                last_opened_at, mode
         FROM recent_workspaces
         WHERE workspace_id = ?`,
      )
      .get(validateWorkspaceId(workspaceId)) as WorkspaceCatalogRow | undefined;
    return row === undefined ? undefined : toWorkspaceCatalogRecord(row);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.raw.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Workspace catalog is closed.");
  }
}

function toRecentWorkspace(row: WorkspaceCatalogRow): RecentWorkspace {
  return {
    workspaceId: row.workspace_id,
    name: row.display_name,
    displayPath: row.display_path,
    lastOpenedAt: row.last_opened_at,
    mode: row.mode,
  };
}

function toWorkspaceCatalogRecord(
  row: WorkspaceCatalogRow,
): WorkspaceCatalogRecord {
  return {
    ...toRecentWorkspace(row),
    canonicalRoot: row.canonical_root,
  };
}

function validateWorkspaceId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes("\0")) {
    throw new TypeError("workspaceId must be a non-empty string.");
  }
  return normalized;
}

function validateCanonicalRoot(value: string): string {
  if (!value || value.includes("\0") || !isAbsolute(value)) {
    throw new TypeError("canonicalRoot must be an absolute path.");
  }
  return normalize(value);
}

function validateDisplayName(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes("\0")) {
    throw new TypeError("Workspace name must be a non-empty string.");
  }
  return normalized;
}
