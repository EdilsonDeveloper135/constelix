import { basename, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { watch, type ChokidarOptions, type FSWatcher } from "chokidar";
import type { TypeScriptResolutionOptions } from "@constelix/analyzers";
import {
  GraphSnapshotSchema,
  PROTOCOL_VERSION,
  sanitizeGraphSnapshot,
  sanitizeUnknownStrings,
  type GraphDelta,
  type GraphEdge,
  type GraphNode,
  type GraphQuery,
  type GraphSnapshot,
  type WorkspaceSummary,
} from "@constelix/contracts";
import { InMemoryGraphStore, stableId } from "@constelix/graph-core";
import { AnalyzerWorkerClient } from "./analyzer-worker-client.js";
import type { ConstelixDatabase, IndexedFileRecord } from "./database.js";
import type { EventBus } from "./events.js";
import {
  FileChangedDuringReadError,
  FileTooLargeError,
  InvalidTextFileError,
  readWorkspaceTextFile,
} from "./files.js";
import {
  buildIgnoreMatcher,
  detectSupportedLanguage,
  isSecretPath,
  MAX_CONFIGURABLE_WORKSPACE_SOURCE_BYTES,
  MAX_WORKSPACE_FILES,
  MAX_WORKSPACE_SOURCE_BYTES,
  readTypeScriptResolutionOptions,
  scanWorkspace,
  type ScanProgress,
  type ScanResult,
  type ScanWorkspaceOptions,
  type ScannedSource,
} from "./scanner.js";
import {
  assertWorkspaceReferenceIdentity,
  workspaceRootOf,
  type WorkspaceReference,
} from "./security.js";

const MAX_INCREMENTAL_CHANGED_PATHS = 24;
const MAX_INCREMENTAL_AFFECTED_FILES = 200;
const INDEX_RULE_FILES = new Set([
  ".gitignore",
  ".constelixignore",
  "tsconfig.json",
  "jsconfig.json",
]);

class IncrementalFallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncrementalFallbackError";
  }
}

export interface IndexStatus {
  phase: "idle" | "scanning" | "parsing" | "resolving" | "persisting" | "ready" | "error";
  completed: number;
  total: number;
  revision: number;
  message?: string;
  lastIndexedAt?: string;
  summary: WorkspaceSummary;
}

export interface WorkspaceIndexerOptions {
  watcherFactory?: (path: string, options: ChokidarOptions) => FSWatcher;
  watcherRestartBaseDelayMs?: number;
  watcherRestartMaxDelayMs?: number;
  scanOptions?: Omit<ScanWorkspaceOptions, "onProgress">;
  assertWorkspace?: () => Promise<void>;
}

export class WorkspaceIndexer {
  readonly graph: InMemoryGraphStore;
  readonly workspaceRoot: string;
  #fullSnapshot: GraphSnapshot;
  #watcher: FSWatcher | undefined;
  #watcherReady = false;
  #watcherReadyPromise: Promise<void> = Promise.resolve();
  #resolveWatcherReady: (() => void) | undefined;
  #watcherRestartTimer: NodeJS.Timeout | undefined;
  #watcherRestartAttempts = 0;
  #timer: NodeJS.Timeout | undefined;
  #active: Promise<void> | undefined;
  #running = false;
  #currentOperation: "full" | "incremental" | undefined;
  #queued = false;
  #closed = false;
  #forceFullReason: string | undefined;
  readonly #pendingChanges = new Set<string>();
  readonly #files = new Map<string, IndexedFileRecord>();
  readonly #analyzer = new AnalyzerWorkerClient();
  #status: IndexStatus;
  #summary: WorkspaceSummary;

  constructor(
    readonly workspaceId: string,
    private readonly workspace: WorkspaceReference,
    private readonly database: ConstelixDatabase,
    private readonly events: EventBus,
    private readonly options: WorkspaceIndexerOptions = {},
  ) {
    this.workspaceRoot = workspaceRootOf(workspace);
    const persisted = database.loadGraph(workspaceId);
    this.#fullSnapshot =
      persisted ??
      GraphSnapshotSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        workspaceId,
        revision: 0,
        nodes: [],
        edges: [],
        truncated: false,
      });
    this.graph = new InMemoryGraphStore(this.#fullSnapshot);
    for (const file of database.loadFiles(workspaceId)) {
      this.#files.set(file.relativePath, file);
    }
    this.#summary = {
      projectTypes: [],
      languages: [
        ...new Set(
          [...this.#files.values()]
            .map((file) => file.language)
            .filter((language): language is WorkspaceSummary["languages"][number] =>
              ["javascript", "typescript", "python"].includes(language),
            ),
        ),
      ],
      estimatedFileCount: this.#files.size,
      indexedFileCount: this.#files.size,
      warnings: [],
      omittedFiles: [],
      omittedFileCount: 0,
      omittedFilesTruncated: false,
    };
    this.#status = {
      phase: persisted ? "ready" : "idle",
      completed: this.#files.size,
      total: this.#files.size,
      revision: this.#fullSnapshot.revision,
      summary: this.#summary,
    };
  }

  get status(): Readonly<IndexStatus> {
    return this.#status;
  }

  get indexedFileCount(): number {
    return this.#files.size;
  }

  async start(): Promise<void> {
    if (this.#watcher) return;
    await this.assertWorkspace();
    this.initializeWatcher(false);
    this.publishStatus("scanning", 0, 0, "Starting filesystem watcher");
    this.schedule("Initial index", 0);
  }

  private initializeWatcher(reconcileOnReady: boolean): void {
    if (this.#closed || this.#watcher !== undefined) return;
    this.#watcherReady = false;
    this.beginWatcherReadyWait();
    const watcherFactory = this.options.watcherFactory ?? watch;
    const watcher = watcherFactory(this.workspaceRoot, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
      ignored: (path) => {
        const normalized = path.replaceAll("\\", "/");
        return (
          /\/(?:\.git|node_modules|dist|build|coverage|\.venv|venv|__pycache__)(?:\/|$)/.test(
            normalized,
          ) || isSecretPath(normalized)
        );
      },
    });
    this.#watcher = watcher;
    watcher.once("ready", () => {
      if (this.#watcher !== watcher) return;
      this.#watcherReady = true;
      this.finishWatcherReadyWait();
      if (reconcileOnReady && this.#currentOperation !== "full") {
        this.schedule("Filesystem watcher recovered; reconciling workspace", 0);
      }
    });
    watcher.on("all", (event, path) => {
      if (this.#watcher !== watcher) return;
      if (event === "add" || event === "change" || event === "unlink") {
        this.schedulePath(path);
      }
    });
    watcher.on("error", (error) => {
      if (this.#watcher !== watcher) return;
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.publishStatus("error", 0, 0, normalized.message);
      this.recoverWatcher(watcher);
    });
  }

  private recoverWatcher(watcher: FSWatcher): void {
    if (this.#closed || this.#watcher !== watcher) return;
    this.#watcher = undefined;
    this.#watcherReady = false;
    this.beginWatcherReadyWait();
    const closeWatcher = watcher.close().catch(() => undefined);
    this.#watcherRestartAttempts += 1;
    const baseDelay = Math.max(1, this.options.watcherRestartBaseDelayMs ?? 250);
    const maximumDelay = Math.max(
      baseDelay,
      this.options.watcherRestartMaxDelayMs ?? 5_000,
    );
    const delay = Math.min(
      maximumDelay,
      baseDelay * 2 ** Math.min(this.#watcherRestartAttempts - 1, 6),
    );
    if (this.#watcherRestartTimer) clearTimeout(this.#watcherRestartTimer);
    this.#watcherRestartTimer = setTimeout(() => {
      this.#watcherRestartTimer = undefined;
      void closeWatcher.then(() => {
        this.initializeWatcher(true);
      });
    }, delay);
    this.#watcherRestartTimer.unref();
  }

  schedule(reason = "Workspace changed", delay = 250): void {
    if (this.#closed) return;
    this.#forceFullReason = reason;
    this.armTimer(delay);
  }

  /** Schedules one known filesystem path for the incremental pipeline. */
  notifyPathChanged(path: string, delay = 25): void {
    this.schedulePath(path, delay);
  }

  private schedulePath(path: string, delay = 250): void {
    if (this.#closed) return;
    const absolutePath = isAbsolute(path) ? path : resolve(this.workspaceRoot, path);
    const fromRoot = relative(this.workspaceRoot, absolutePath);
    if (
      fromRoot === ".." ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      this.#forceFullReason = "Watcher reported a path outside the workspace";
      this.armTimer(delay);
      return;
    }

    const relativePath = fromRoot.split(sep).join("/") || ".";
    if (INDEX_RULE_FILES.has(relativePath)) {
      this.#forceFullReason = `Index rules changed: ${relativePath}`;
    } else if (detectSupportedLanguage(relativePath) !== undefined || this.#files.has(relativePath)) {
      this.#pendingChanges.add(relativePath);
    }
    this.armTimer(delay);
  }

  private armTimer(delay: number): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.launchScheduledWork();
    }, delay);
    this.#timer.unref();
  }

  private launchScheduledWork(): void {
    if (this.#closed) return;
    if (this.#running) {
      this.#queued = true;
      return;
    }

    const forceFullReason = this.#forceFullReason;
    this.#forceFullReason = undefined;
    const changedPaths = [...this.#pendingChanges].sort();
    this.#pendingChanges.clear();
    const truncatedIndexReason = this.#fullSnapshot.truncated
      ? "Truncated index changed; rebuilding within scanner limits"
      : undefined;
    const fullReason = forceFullReason ?? truncatedIndexReason;
    const operation =
      fullReason !== undefined || this.#fullSnapshot.revision === 0
        ? this.reindex(fullReason ?? "Initial index")
        : this.reindexIncrementally(changedPaths);
    const tracked = operation.finally(() => {
      if (this.#active === tracked) this.#active = undefined;
    });
    this.#active = tracked;
  }

  query(query: GraphQuery): GraphSnapshot {
    return this.graph.query(query);
  }

  private async reindex(reason: string): Promise<void> {
    if (this.#running) {
      this.#queued = true;
      return;
    }
    this.#running = true;
    this.#currentOperation = "full";
    const revision = this.#fullSnapshot.revision + 1;
    try {
      await this.assertWorkspace();
      const scanStartedBeforeWatcherReady = !this.#watcherReady;
      this.publishStatus("scanning", 0, 0, reason);
      let scan = await this.scanWorkspaceProgressively();
      let normalized = await this.analyzeScan(scan, revision);

      if (scanStartedBeforeWatcherReady) {
        this.publishStatus(
          "scanning",
          scan.files.length,
          scan.files.length,
          "Synchronizing filesystem watcher",
          { filesIndexed: scan.files.length },
        );
        await this.waitForWatcherReady();
        const reconciledScan = await this.scanWorkspaceProgressively();
        if (!scansMatch(scan, reconciledScan)) {
          scan = reconciledScan;
          normalized = await this.analyzeScan(scan, revision);
        }
      } else {
        await this.waitForWatcherReady();
      }

      const snapshot = GraphSnapshotSchema.parse(normalized.snapshot);
      await this.assertWorkspace();
      this.publishStatus(
        "persisting",
        scan.files.length,
        scan.files.length,
        undefined,
        { filesIndexed: scan.files.length },
      );
      this.database.replaceIndexRevision(
        this.workspaceId,
        snapshot,
        scan.files,
        [...scan.diagnostics, ...normalized.diagnostics],
      );
      this.#files.clear();
      for (const file of scan.files) this.#files.set(file.relativePath, toFileRecord(file));
      this.#summary = scan.summary;
      this.graph.replace(snapshot);
      this.#fullSnapshot = snapshot;
      const graphPage = this.graph.snapshot(500);
      this.events.publish("graph.snapshot", {
        graph: GraphSnapshotSchema.parse({
          ...graphPage,
          truncated: graphPage.truncated || snapshot.truncated,
        }),
        provisional: false,
      });
      if (this.#watcherReady) this.#watcherRestartAttempts = 0;
      if (
        !this.#queued &&
        this.#pendingChanges.size === 0 &&
        this.#forceFullReason === undefined
      ) {
        this.publishStatus(
          "ready",
          scan.files.length,
          scan.files.length,
          scan.truncated
            ? scan.summary.warnings.at(-1)?.message ??
              "Workspace index is truncated by scanner limits."
            : undefined,
          {
            lastIndexedAt: new Date().toISOString(),
          },
        );
      }
    } catch (error) {
      if (!this.#closed) {
        const message = error instanceof Error ? error.message : "Indexing failed.";
        this.publishStatus("error", 0, 0, message);
        this.database.audit(this.workspaceId, "index", "reindex", "failed", { message });
      }
    } finally {
      this.#currentOperation = undefined;
      this.#running = false;
      if (this.#queued || this.#pendingChanges.size > 0 || this.#forceFullReason !== undefined) {
        this.#queued = false;
        this.armTimer(50);
      }
    }
  }

  private scanWorkspaceProgressively(): Promise<ScanResult> {
    const configuredMaximum = this.options.scanOptions?.maxFiles ?? MAX_WORKSPACE_FILES;
    const maximumFiles = Math.min(
      Math.max(Math.trunc(configuredMaximum), 1),
      MAX_WORKSPACE_FILES,
    );
    return scanWorkspace(this.workspaceId, this.workspace, {
      ...this.options.scanOptions,
      onProgress: (progress) => {
        this.#summary = progress.summary;
        this.publishProvisionalScan(progress);
        const total = progress.complete ? progress.files.length : maximumFiles;
        const truncationMessage = progress.truncated
          ? progress.diagnostics.at(-1)?.message
          : undefined;
        this.publishStatus(
          "scanning",
          progress.files.length,
          total,
          truncationMessage ??
            (progress.complete
              ? `Filesystem scan found ${progress.files.length} supported source files`
              : `Scanning workspace: ${progress.files.length} supported source files discovered`),
          { filesIndexed: progress.files.length },
        );
      },
    });
  }

  private publishProvisionalScan(
    progress: Pick<ScanProgress, "files" | "complete" | "truncated">,
  ): void {
    if (this.#fullSnapshot.revision !== 0) return;
    const provisional = createFileSystemSnapshot(
      this.workspaceId,
      this.#fullSnapshot.revision,
      basename(this.workspaceRoot),
      progress.files,
      true,
      progress.truncated,
    );
    this.graph.replace(provisional);
    const graphPage = this.graph.snapshot(500);
    this.events.publish("graph.snapshot", {
      graph: GraphSnapshotSchema.parse({
        ...graphPage,
        truncated:
          graphPage.truncated || !progress.complete || progress.truncated,
      }),
      provisional: true,
    });
  }

  private async analyzeScan(
    scan: ScanResult,
    revision: number,
  ): Promise<ReturnType<typeof normalizeAnalysisResult>> {
    this.publishStatus("parsing", 0, scan.files.length, undefined, {
      filesIndexed: scan.files.length,
    });
    const typeScriptResolution = await readTypeScriptResolutionOptions(
      this.workspace,
    );
    const analysisResult = await this.#analyzer.analyze(
      scan.files.map((file) => ({
        workspaceId: this.workspaceId,
        relativePath: file.relativePath,
        source: file.source,
        revision,
      })),
      {
        workspaceId: this.workspaceId,
        revision,
        projectName: basename(this.workspaceRoot),
        ...(typeScriptResolution === undefined ? {} : { typeScriptResolution }),
      },
    );
    this.publishStatus(
      "resolving",
      scan.files.length,
      scan.files.length,
      undefined,
      { filesIndexed: scan.files.length },
    );
    return normalizeAnalysisResult(
      analysisResult,
      this.workspaceId,
      revision,
      scan.files,
      scan.truncated,
    );
  }

  private async waitForWatcherReady(): Promise<void> {
    while (!this.#closed) {
      if (this.#watcherReady) return;
      const readiness = this.#watcherReadyPromise;
      await readiness;
    }
    throw new Error("Filesystem watcher closed before becoming ready.");
  }

  private beginWatcherReadyWait(): void {
    if (this.#resolveWatcherReady !== undefined) return;
    this.#watcherReadyPromise = new Promise((resolveReady) => {
      this.#resolveWatcherReady = resolveReady;
    });
  }

  private finishWatcherReadyWait(): void {
    this.#resolveWatcherReady?.();
    this.#resolveWatcherReady = undefined;
  }

  private async reindexIncrementally(changedPaths: readonly string[]): Promise<void> {
    if (changedPaths.length === 0) return;
    if (changedPaths.length > MAX_INCREMENTAL_CHANGED_PATHS) {
      this.#forceFullReason = `Incremental batch exceeded ${MAX_INCREMENTAL_CHANGED_PATHS} paths`;
      this.armTimer(50);
      return;
    }

    this.#running = true;
    this.#currentOperation = "incremental";
    const revision = this.#fullSnapshot.revision + 1;
    try {
      await this.assertWorkspace();
      this.publishStatus("scanning", 0, changedPaths.length, "Applying filesystem changes");
      const changedSources = new Map<string, ScannedSource>();
      const removedPaths = new Set<string>();
      const diagnostics: Array<{ relativePath?: string; message: string }> = [];
      const matcher = await buildIgnoreMatcher(this.workspace, (diagnostic) => {
        diagnostics.push(diagnostic);
      });
      const sourceByteLimit = boundedSourceByteLimit(
        this.options.scanOptions?.maxTotalBytes,
      );
      let affectedSourceBytes = 0;

      for (const relativePath of changedPaths) {
        const language = detectSupportedLanguage(relativePath);
        if (
          language === undefined ||
          isSecretPath(relativePath) ||
          matcher.ignores(relativePath)
        ) {
          if (this.#files.has(relativePath)) removedPaths.add(relativePath);
          continue;
        }
        const source = await this.readIncrementalSource(relativePath, diagnostics);
        if (source === undefined) removedPaths.add(relativePath);
        else if (this.#files.get(relativePath)?.contentHash !== source.contentHash) {
          affectedSourceBytes += source.sizeBytes;
          if (affectedSourceBytes > sourceByteLimit) {
            throw incrementalSourceBudgetError(sourceByteLimit);
          }
          changedSources.set(relativePath, source);
        }
      }

      if (changedSources.size === 0 && removedPaths.size === 0) {
        this.publishStatus(
          "ready",
          this.#files.size,
          this.#files.size,
          undefined,
          this.#status.lastIndexedAt === undefined
            ? {}
            : { lastIndexedAt: this.#status.lastIndexedAt },
        );
        return;
      }

      const typeScriptResolution = await readTypeScriptResolutionOptions(
        this.workspace,
      );
      const affectedPaths = this.collectAffectedPaths(
        new Set(changedPaths),
        changedSources.values(),
        typeScriptResolution,
      );
      if (affectedPaths.size > MAX_INCREMENTAL_AFFECTED_FILES) {
        throw new IncrementalFallbackError(
          `Incremental dependency closure exceeded ${MAX_INCREMENTAL_AFFECTED_FILES} files.`,
        );
      }

      const affectedSources = new Map(changedSources);
      for (const relativePath of affectedPaths) {
        if (affectedSources.has(relativePath) || removedPaths.has(relativePath)) continue;
        const source = await this.readIncrementalSource(relativePath, diagnostics);
        if (source === undefined) removedPaths.add(relativePath);
        else {
          affectedSourceBytes += source.sizeBytes;
          if (affectedSourceBytes > sourceByteLimit) {
            throw incrementalSourceBudgetError(sourceByteLimit);
          }
          affectedSources.set(relativePath, source);
        }
      }

      this.publishStatus("parsing", 0, affectedSources.size);
      const sourceFiles = [...affectedSources.values()];
      const analysisResult = await this.#analyzer.analyze(
        sourceFiles.map((file) => ({
          workspaceId: this.workspaceId,
          relativePath: file.relativePath,
          source: file.source,
          revision,
        })),
        {
          workspaceId: this.workspaceId,
          revision,
          projectName: basename(this.workspaceRoot),
          ...(typeScriptResolution === undefined ? {} : { typeScriptResolution }),
        },
      );
      this.publishStatus("resolving", sourceFiles.length, sourceFiles.length);
      const normalized = normalizeAnalysisResult(
        analysisResult,
        this.workspaceId,
        revision,
        sourceFiles,
      );
      const snapshot = mergeIncrementalSnapshot(
        this.#fullSnapshot,
        normalized.snapshot,
        new Set([...affectedPaths, ...removedPaths]),
        revision,
      );
      const delta = diffIncrementalSnapshots(this.#fullSnapshot, snapshot);

      await this.assertWorkspace();
      this.publishStatus("persisting", sourceFiles.length, sourceFiles.length);
      this.database.applyGraphDelta(
        this.workspaceId,
        delta,
        {
          upsert: sourceFiles.map(toFileRecord),
          removedPaths: [...removedPaths],
        },
        [...diagnostics, ...normalized.diagnostics],
      );
      for (const relativePath of removedPaths) this.#files.delete(relativePath);
      for (const file of sourceFiles) this.#files.set(file.relativePath, toFileRecord(file));
      this.graph.applyDelta(delta);
      this.#fullSnapshot = snapshot;
      this.refreshSummaryFromFiles();
      this.events.publish("graph.delta", delta);
      this.publishStatus("ready", this.#files.size, this.#files.size, undefined, {
        lastIndexedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (!this.#closed) {
        const message = error instanceof Error ? error.message : "Incremental indexing failed.";
        this.database.audit(this.workspaceId, "index", "incremental", "fallback", { message });
        this.#forceFullReason = `Incremental reconciliation fallback: ${message}`;
        this.#queued = true;
      }
    } finally {
      this.#currentOperation = undefined;
      this.#running = false;
      if (this.#queued || this.#pendingChanges.size > 0 || this.#forceFullReason !== undefined) {
        this.#queued = false;
        this.armTimer(50);
      }
    }
  }

  private async readIncrementalSource(
    relativePath: string,
    diagnostics: Array<{ relativePath?: string; message: string }>,
  ): Promise<ScannedSource | undefined> {
    const language = detectSupportedLanguage(relativePath);
    if (language === undefined) return undefined;
    try {
      const file = await readWorkspaceTextFile(this.workspace, relativePath);
      return {
        workspaceId: this.workspaceId,
        relativePath,
        absolutePath: resolve(this.workspaceRoot, relativePath),
        source: file.content,
        language,
        sizeBytes: file.sizeBytes,
        mtimeMs: file.mtimeMs,
        contentHash: file.contentHash,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      if (
        error instanceof FileTooLargeError ||
        error instanceof InvalidTextFileError ||
        error instanceof FileChangedDuringReadError
      ) {
        diagnostics.push({ relativePath, message: error.message });
        return undefined;
      }
      throw error;
    }
  }

  private collectAffectedPaths(
    changedPaths: ReadonlySet<string>,
    changedSources: Iterable<ScannedSource>,
    typeScriptResolution?: TypeScriptResolutionOptions,
  ): Set<string> {
    const affected = new Set(changedPaths);
    const nodeById = new Map(this.#fullSnapshot.nodes.map((node) => [node.id, node]));
    const sources = [...changedSources];

    // A new module can satisfy an import that was previously represented by an
    // external node. Reanalyze those importers so the edge can be promoted to
    // the real module. This is intentionally conservative because aliases and
    // Python package imports cannot be matched reliably from a path alone.
    if (sources.some((source) => !this.#files.has(source.relativePath))) {
      for (const edge of this.#fullSnapshot.edges) {
        if (edge.relation !== "imports") continue;
        if (nodeById.get(edge.target)?.kind !== "external") continue;
        const importerPath = nodeById.get(edge.source)?.relativePath;
        if (importerPath !== undefined && this.#files.has(importerPath)) {
          affected.add(importerPath);
          if (affected.size > MAX_INCREMENTAL_AFFECTED_FILES) break;
        }
      }
    }

    const changedNodeIds = new Set(
      this.#fullSnapshot.nodes
        .filter((node) => affected.has(node.relativePath))
        .map((node) => node.id),
    );
    for (const edge of this.#fullSnapshot.edges) {
      if (!changedNodeIds.has(edge.source) && !changedNodeIds.has(edge.target)) continue;
      for (const nodeId of [edge.source, edge.target]) {
        const relativePath = nodeById.get(nodeId)?.relativePath;
        if (relativePath !== undefined && this.#files.has(relativePath)) affected.add(relativePath);
      }
    }

    const hints = new Set<string>();
    for (const source of sources) {
      for (const hint of extractReferenceHints(source.source)) {
        hints.add(hint);
        if (hint.startsWith(".")) {
          hints.add(
            normalizeReferenceHint(
              posix.join(posix.dirname(source.relativePath), hint),
            ),
          );
        }
      }
    }
    if (hints.size > 0) {
      const referenceHints = expandTypeScriptReferenceHints(
        hints,
        typeScriptResolution,
      );
      for (const relativePath of this.#files.keys()) {
        if (referenceHints.some((hint) => pathMatchesReference(relativePath, hint))) {
          affected.add(relativePath);
          if (affected.size > MAX_INCREMENTAL_AFFECTED_FILES) break;
        }
      }
    }
    return affected;
  }

  private publishStatus(
    phase: IndexStatus["phase"],
    completed: number,
    total: number,
    message?: string,
    extra: Pick<IndexStatus, "lastIndexedAt"> & {
      filesIndexed?: number;
    } = {},
  ): void {
    this.#status = {
      phase,
      completed,
      total,
      revision: this.#fullSnapshot.revision,
      summary: this.#summary,
      ...(message === undefined ? {} : { message }),
      ...(extra.lastIndexedAt === undefined ? {} : { lastIndexedAt: extra.lastIndexedAt }),
    };
    const progress = total === 0 ? 0 : completed / total;
    this.events.publish("index.progress", {
      phase: phase === "idle" ? "scanning" : phase,
      completed,
      total,
      revision: this.#fullSnapshot.revision,
      progress,
      filesIndexed: extra.filesIndexed ?? this.#files.size,
      symbolsIndexed: this.graph.nodeCount,
      edgesIndexed: this.graph.edgeCount,
      summary: this.#summary,
      ...(message === undefined ? {} : { message }),
    });
  }

  private async assertWorkspace(): Promise<void> {
    await assertWorkspaceReferenceIdentity(this.workspace);
    await this.options.assertWorkspace?.();
  }

  private refreshSummaryFromFiles(): void {
    const languages = [
      ...new Set(
        [...this.#files.values()]
          .map((file) => file.language)
          .filter((language): language is WorkspaceSummary["languages"][number] =>
            ["javascript", "typescript", "python"].includes(language),
          ),
      ),
    ].sort();
    this.#summary = {
      ...this.#summary,
      languages,
      indexedFileCount: this.#files.size,
      estimatedFileCount: this.#fullSnapshot.truncated
        ? Math.max(this.#summary.estimatedFileCount, this.#files.size)
        : this.#files.size,
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#watcherRestartTimer) clearTimeout(this.#watcherRestartTimer);
    this.finishWatcherReadyWait();
    await this.#watcher?.close();
    this.#watcher = undefined;
    await this.#analyzer.close();
    await this.#active;
  }
}

function toFileRecord(file: ScannedSource): IndexedFileRecord {
  return {
    relativePath: file.relativePath,
    contentHash: file.contentHash,
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
    language: file.language,
  };
}

function scansMatch(left: ScanResult, right: ScanResult): boolean {
  if (
    left.truncated !== right.truncated ||
    left.files.length !== right.files.length
  ) {
    return false;
  }
  for (let index = 0; index < left.files.length; index += 1) {
    const leftFile = left.files[index];
    const rightFile = right.files[index];
    if (
      leftFile === undefined ||
      rightFile === undefined ||
      leftFile.relativePath !== rightFile.relativePath ||
      leftFile.contentHash !== rightFile.contentHash
    ) {
      return false;
    }
  }
  return true;
}

function extractReferenceHints(source: string): string[] {
  const hints = new Set<string>();
  const javascript =
    /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g;
  const python = /^\s*(?:from|import)\s+([.\w]+)/gm;
  for (const match of source.matchAll(javascript)) {
    const value = match[1]?.replaceAll("\\", "/");
    if (value) hints.add(value);
  }
  for (const match of source.matchAll(python)) {
    const value = match[1]?.replaceAll(".", "/").replace(/^\/+/, "");
    if (value) hints.add(value);
  }
  return [...hints];
}

function expandTypeScriptReferenceHints(
  hints: ReadonlySet<string>,
  options: TypeScriptResolutionOptions | undefined,
): string[] {
  const expanded = new Set(
    [...hints].map(normalizeReferenceHint).filter(Boolean),
  );
  if (options === undefined) return [...expanded];

  for (const hint of hints) {
    if (!hint.startsWith(".")) {
      expanded.add(
        normalizeReferenceHint(posix.join(options.baseUrl, hint)),
      );
    }
    for (const [pattern, targets] of Object.entries(options.paths)) {
      const wildcard = matchTypeScriptPathPattern(pattern, hint);
      if (wildcard === undefined) continue;
      for (const target of targets) {
        expanded.add(
          normalizeReferenceHint(
            posix.join(
              options.baseUrl,
              target.replaceAll("*", wildcard),
            ),
          ),
        );
      }
    }
  }
  return [...expanded].filter(Boolean);
}

function matchTypeScriptPathPattern(
  pattern: string,
  specifier: string,
): string | undefined {
  const wildcardIndex = pattern.indexOf("*");
  if (wildcardIndex === -1) return pattern === specifier ? "" : undefined;
  const prefix = pattern.slice(0, wildcardIndex);
  const suffix = pattern.slice(wildcardIndex + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
    return undefined;
  }
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function normalizeReferenceHint(value: string): string {
  return posix
    .normalize(value.replaceAll("\\", "/"))
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

function pathMatchesReference(relativePath: string, reference: string): boolean {
  const pathWithoutExtension = relativePath.replace(/\.(?:[cm]?[jt]sx?|pyi?)$/i, "");
  const normalizedReference = reference.replace(/\.(?:[cm]?[jt]sx?|pyi?)$/i, "");
  return (
    pathWithoutExtension === normalizedReference ||
    pathWithoutExtension.endsWith(`/${normalizedReference}`) ||
    pathWithoutExtension === `${normalizedReference}/index` ||
    pathWithoutExtension.endsWith(`/${normalizedReference}/index`)
  );
}

export function mergeIncrementalSnapshot(
  previous: GraphSnapshot,
  partial: GraphSnapshot,
  affectedPaths: ReadonlySet<string>,
  revision: number,
): GraphSnapshot {
  const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  const previousEdges = new Map(previous.edges.map((edge) => [edge.id, edge]));
  const nodes = new Map(previous.nodes.map((node) => [node.id, node]));
  const edges = new Map(previous.edges.map((edge) => [edge.id, edge]));
  const removedNodeIds = new Set(
    previous.nodes.filter((node) => affectedPaths.has(node.relativePath)).map((node) => node.id),
  );

  for (const nodeId of removedNodeIds) nodes.delete(nodeId);
  for (const [edgeId, edge] of edges) {
    if (
      removedNodeIds.has(edge.source) ||
      removedNodeIds.has(edge.target) ||
      edge.evidence.some((evidence) => affectedPaths.has(evidence.relativePath))
    ) {
      edges.delete(edgeId);
    }
  }

  for (const node of partial.nodes) {
    if (
      affectedPaths.has(node.relativePath) ||
      node.kind === "external" ||
      !nodes.has(node.id)
    ) {
      const old = previousNodes.get(node.id);
      nodes.set(node.id, old !== undefined && sameEntity(old, node) ? old : node);
    }
  }
  for (const edge of partial.edges) {
    if (nodes.has(edge.source) && nodes.has(edge.target)) {
      const old = previousEdges.get(edge.id);
      edges.set(edge.id, old !== undefined && sameEntity(old, edge) ? old : edge);
    }
  }

  pruneDanglingEdges(nodes, edges);
  pruneUnreferencedNodes(nodes, edges, "external");
  pruneEmptyFolders(nodes, edges);
  pruneDanglingEdges(nodes, edges);

  return {
    protocolVersion: PROTOCOL_VERSION,
    workspaceId: previous.workspaceId,
    revision,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    truncated: previous.truncated || partial.truncated,
  };
}

function boundedSourceByteLimit(configured: number | undefined): number {
  const value = configured ?? MAX_WORKSPACE_SOURCE_BYTES;
  return Math.min(
    Math.max(Number.isFinite(value) ? Math.trunc(value) : MAX_WORKSPACE_SOURCE_BYTES, 1),
    MAX_CONFIGURABLE_WORKSPACE_SOURCE_BYTES,
  );
}

function incrementalSourceBudgetError(limit: number): IncrementalFallbackError {
  return new IncrementalFallbackError(
    `Incremental source batch exceeded the ${limit} byte aggregate source-memory limit.`,
  );
}

function diffIncrementalSnapshots(previous: GraphSnapshot, next: GraphSnapshot): GraphDelta {
  const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  const nextNodes = new Map(next.nodes.map((node) => [node.id, node]));
  const previousEdges = new Map(previous.edges.map((edge) => [edge.id, edge]));
  const nextEdges = new Map(next.edges.map((edge) => [edge.id, edge]));
  return {
    protocolVersion: PROTOCOL_VERSION,
    workspaceId: next.workspaceId,
    previousRevision: previous.revision,
    revision: next.revision,
    nodesAdded: next.nodes.filter((node) => !previousNodes.has(node.id)),
    nodesUpdated: next.nodes.filter((node) => {
      const old = previousNodes.get(node.id);
      return old !== undefined && node.revision === next.revision && !sameEntity(old, node);
    }),
    nodeIdsRemoved: previous.nodes
      .filter((node) => !nextNodes.has(node.id))
      .map((node) => node.id),
    edgesAdded: next.edges.filter((edge) => !previousEdges.has(edge.id)),
    edgesUpdated: next.edges.filter((edge) => {
      const old = previousEdges.get(edge.id);
      return old !== undefined && edge.revision === next.revision && !sameEntity(old, edge);
    }),
    edgeIdsRemoved: previous.edges
      .filter((edge) => !nextEdges.has(edge.id))
      .map((edge) => edge.id),
  };
}

function sameEntity(left: GraphNode | GraphEdge, right: GraphNode | GraphEdge): boolean {
  const { revision: _leftRevision, ...leftComparable } = left;
  const { revision: _rightRevision, ...rightComparable } = right;
  return stableSerialize(leftComparable) === stableSerialize(rightComparable);
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`);
  return `{${entries.join(",")}}`;
}

function pruneDanglingEdges(
  nodes: ReadonlyMap<string, GraphNode>,
  edges: Map<string, GraphEdge>,
): void {
  for (const [edgeId, edge] of edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) edges.delete(edgeId);
  }
}

function pruneUnreferencedNodes(
  nodes: Map<string, GraphNode>,
  edges: ReadonlyMap<string, GraphEdge>,
  kind: GraphNode["kind"],
): void {
  const referenced = new Set<string>();
  for (const edge of edges.values()) {
    referenced.add(edge.source);
    referenced.add(edge.target);
  }
  for (const [nodeId, node] of nodes) {
    if (node.kind === kind && !referenced.has(nodeId)) nodes.delete(nodeId);
  }
}

function pruneEmptyFolders(nodes: Map<string, GraphNode>, edges: Map<string, GraphEdge>): void {
  let changed = true;
  while (changed) {
    changed = false;
    const containers = new Set(
      [...edges.values()]
        .filter((edge) => edge.relation === "contains")
        .map((edge) => edge.source),
    );
    for (const [nodeId, node] of nodes) {
      if (node.kind !== "folder" || containers.has(nodeId)) continue;
      nodes.delete(nodeId);
      for (const [edgeId, edge] of edges) {
        if (edge.source === nodeId || edge.target === nodeId) edges.delete(edgeId);
      }
      changed = true;
    }
  }
}

function normalizeAnalysisResult(
  result: unknown,
  workspaceId: string,
  revision: number,
  files: readonly ScannedSource[],
  sourceTruncated = false,
): { snapshot: GraphSnapshot; diagnostics: unknown[] } {
  const candidate = result as { snapshot?: unknown; diagnostics?: unknown[] };
  const snapshotInput = candidate.snapshot ?? result;
  const parsed = GraphSnapshotSchema.safeParse(snapshotInput);
  if (parsed.success) {
    const nodes = parsed.data.nodes.map((node) => ({ ...node, revision }));
    const edges = parsed.data.edges.map((edge) => ({ ...edge, revision }));
    return {
      snapshot: sanitizeGraphSnapshot(
        GraphSnapshotSchema.parse({
          ...parsed.data,
          protocolVersion: PROTOCOL_VERSION,
          workspaceId,
          revision,
          nodes,
          edges,
          truncated: sourceTruncated,
          cursor: undefined,
        }),
      ),
      diagnostics: sanitizeUnknownStrings(candidate.diagnostics ?? []) as unknown[],
    };
  }

  // A degraded file graph keeps the dashboard useful if a native parser fails.
  return {
    snapshot: createFallbackSnapshot(
      workspaceId,
      revision,
      files,
      sourceTruncated,
    ),
    diagnostics: sanitizeUnknownStrings([
      ...(candidate.diagnostics ?? []),
      { message: "Language analyzers returned no valid snapshot; file-only graph was used." },
    ]) as unknown[],
  };
}

function createFallbackSnapshot(
  workspaceId: string,
  revision: number,
  files: readonly ScannedSource[],
  sourceTruncated = false,
): GraphSnapshot {
  return createFileSystemSnapshot(
    workspaceId,
    revision,
    basename(workspaceId),
    files,
    false,
    sourceTruncated,
  );
}

function createFileSystemSnapshot(
  workspaceId: string,
  revision: number,
  projectName: string,
  files: readonly ScannedSource[],
  provisional: boolean,
  sourceTruncated = false,
): GraphSnapshot {
  const projectId = stableId("node", workspaceId, "project");
  const project: GraphNode = {
    protocolVersion: PROTOCOL_VERSION,
    id: projectId,
    kind: "project",
    name: projectName,
    qualifiedName: projectName,
    relativePath: "",
    language: "unknown",
    revision,
    metadata: provisional ? { provisional: true } : { degraded: true },
  };
  const nodes = new Map<string, GraphNode>([[project.id, project]]);
  const edges = new Map<string, GraphEdge>();
  for (const file of files) {
    const parts = file.relativePath.split("/");
    const fileName = parts.pop() ?? file.relativePath;
    let parentId = projectId;
    let folderPath = "";
    for (const folderName of parts) {
      folderPath = folderPath ? `${folderPath}/${folderName}` : folderName;
      const folderId = stableId("node", workspaceId, "folder", folderPath);
      if (!nodes.has(folderId)) {
        nodes.set(folderId, {
          protocolVersion: PROTOCOL_VERSION,
          id: folderId,
          kind: "folder",
          name: folderName,
          qualifiedName: folderPath,
          relativePath: folderPath,
          language: "unknown",
          revision,
          metadata: provisional ? { provisional: true } : { degraded: true },
        });
        const edge: GraphEdge = {
          protocolVersion: PROTOCOL_VERSION,
          id: stableId("edge", parentId, folderId, "contains"),
          source: parentId,
          target: folderId,
          relation: "contains",
          confidence: "extracted",
          evidence: [],
          revision,
          metadata: {},
        };
        edges.set(edge.id, edge);
      }
      parentId = folderId;
    }
    const id = stableId("node", workspaceId, "file", file.relativePath);
    nodes.set(id, {
      protocolVersion: PROTOCOL_VERSION,
      id,
      kind: "file",
      name: fileName,
      qualifiedName: file.relativePath,
      relativePath: file.relativePath,
      language: file.language,
      revision,
      metadata: {
        contentHash: file.contentHash,
        ...(provisional ? { provisional: true } : { degraded: true }),
      },
    });
    const edge: GraphEdge = {
      protocolVersion: PROTOCOL_VERSION,
      id: stableId("edge", parentId, id, "contains"),
      source: parentId,
      target: id,
      relation: "contains",
      confidence: "extracted",
      evidence: [],
      revision,
      metadata: {},
    };
    edges.set(edge.id, edge);
  }
  return sanitizeGraphSnapshot(GraphSnapshotSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    workspaceId,
    revision,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    truncated: sourceTruncated,
  }));
}
