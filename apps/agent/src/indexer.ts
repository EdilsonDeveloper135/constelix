import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { watch, type ChokidarOptions, type FSWatcher } from "chokidar";
import {
  GraphSnapshotSchema,
  PROTOCOL_VERSION,
  type GraphDelta,
  type GraphEdge,
  type GraphNode,
  type GraphQuery,
  type GraphSnapshot,
} from "@constelix/contracts";
import { InMemoryGraphStore, diffSnapshots, stableId } from "@constelix/graph-core";
import { AnalyzerWorkerClient } from "./analyzer-worker-client.js";
import type { ConstelixDatabase, IndexedFileRecord } from "./database.js";
import type { EventBus } from "./events.js";
import { FileTooLargeError, readWorkspaceTextFile } from "./files.js";
import {
  buildIgnoreMatcher,
  detectSupportedLanguage,
  isSecretPath,
  scanWorkspace,
  type ScanResult,
  type ScannedSource,
} from "./scanner.js";

const MAX_INCREMENTAL_CHANGED_PATHS = 24;
const MAX_INCREMENTAL_AFFECTED_FILES = 200;
const INDEX_RULE_FILES = new Set([".gitignore", ".constelixignore"]);

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
}

export interface WorkspaceIndexerOptions {
  watcherFactory?: (path: string, options: ChokidarOptions) => FSWatcher;
}

export class WorkspaceIndexer {
  readonly graph: InMemoryGraphStore;
  #fullSnapshot: GraphSnapshot;
  #watcher: FSWatcher | undefined;
  #watcherReady = false;
  #watcherReadyError: Error | undefined;
  #watcherReadyPromise: Promise<void> = Promise.resolve();
  #resolveWatcherReady: (() => void) | undefined;
  #timer: NodeJS.Timeout | undefined;
  #active: Promise<void> | undefined;
  #running = false;
  #queued = false;
  #closed = false;
  #forceFullReason: string | undefined;
  readonly #pendingChanges = new Set<string>();
  readonly #files = new Map<string, IndexedFileRecord>();
  readonly #analyzer = new AnalyzerWorkerClient();
  #status: IndexStatus;

  constructor(
    readonly workspaceId: string,
    readonly workspaceRoot: string,
    private readonly database: ConstelixDatabase,
    private readonly events: EventBus,
    private readonly options: WorkspaceIndexerOptions = {},
  ) {
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
    this.#status = {
      phase: persisted ? "ready" : "idle",
      completed: persisted?.nodes.length ?? 0,
      total: persisted?.nodes.length ?? 0,
      revision: this.#fullSnapshot.revision,
    };
  }

  get status(): Readonly<IndexStatus> {
    return this.#status;
  }

  async start(): Promise<void> {
    if (this.#watcher) return;
    this.#watcherReady = false;
    this.#watcherReadyError = undefined;
    this.#watcherReadyPromise = new Promise((resolveReady) => {
      this.#resolveWatcherReady = resolveReady;
    });
    const watcherFactory = this.options.watcherFactory ?? watch;
    this.#watcher = watcherFactory(this.workspaceRoot, {
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
    this.#watcher.once("ready", () => {
      this.#watcherReady = true;
      this.finishWatcherReadyWait();
    });
    this.#watcher.on("all", (event, path) => {
      if (event === "add" || event === "change" || event === "unlink") {
        this.schedulePath(path);
      }
    });
    this.#watcher.on("error", (error) => {
      if (!this.#watcherReady) {
        this.#watcherReadyError =
          error instanceof Error ? error : new Error(String(error));
        this.finishWatcherReadyWait();
      }
      this.publishStatus("error", 0, 0, String(error));
    });
    this.publishStatus("scanning", 0, 0, "Starting filesystem watcher");
    this.schedule("Initial index", 0);
  }

  schedule(reason = "Workspace changed", delay = 250): void {
    if (this.#closed) return;
    this.#forceFullReason = reason;
    this.armTimer(delay);
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
    const operation =
      forceFullReason !== undefined || this.#fullSnapshot.revision === 0
        ? this.reindex(forceFullReason ?? "Initial index")
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
    const revision = this.#fullSnapshot.revision + 1;
    try {
      const scanStartedBeforeWatcherReady = !this.#watcherReady;
      this.publishStatus("scanning", 0, 0, reason);
      let scan = await scanWorkspace(this.workspaceId, this.workspaceRoot);
      let normalized = await this.analyzeScan(scan, revision);

      if (scanStartedBeforeWatcherReady) {
        this.publishStatus(
          "scanning",
          scan.files.length,
          scan.files.length,
          "Synchronizing filesystem watcher",
        );
        await this.waitForWatcherReady();
        const reconciledScan = await scanWorkspace(this.workspaceId, this.workspaceRoot);
        if (!scansMatch(scan, reconciledScan)) {
          scan = reconciledScan;
          normalized = await this.analyzeScan(scan, revision);
        }
      } else {
        await this.waitForWatcherReady();
      }

      const snapshot = GraphSnapshotSchema.parse(normalized.snapshot);
      this.publishStatus("persisting", scan.files.length, scan.files.length);
      const delta = diffSnapshots(this.#fullSnapshot, snapshot);
      this.database.replaceGraph(this.workspaceId, snapshot, [
        ...scan.diagnostics,
        ...normalized.diagnostics,
      ]);
      this.database.replaceFiles(this.workspaceId, revision, scan.files);
      this.#files.clear();
      for (const file of scan.files) this.#files.set(file.relativePath, toFileRecord(file));
      this.graph.replace(snapshot);
      this.#fullSnapshot = snapshot;
      this.events.publish("graph.delta", delta);
      this.events.publish("graph.snapshot", { graph: this.graph.snapshot(500) });
      if (
        !this.#queued &&
        this.#pendingChanges.size === 0 &&
        this.#forceFullReason === undefined
      ) {
        this.publishStatus("ready", scan.files.length, scan.files.length, undefined, {
          lastIndexedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Indexing failed.";
      this.publishStatus("error", 0, 0, message);
      this.database.audit(this.workspaceId, "index", "reindex", "failed", { message });
    } finally {
      this.#running = false;
      if (this.#queued || this.#pendingChanges.size > 0 || this.#forceFullReason !== undefined) {
        this.#queued = false;
        this.armTimer(50);
      }
    }
  }

  private async analyzeScan(
    scan: ScanResult,
    revision: number,
  ): Promise<ReturnType<typeof normalizeAnalysisResult>> {
    this.publishStatus("parsing", 0, scan.files.length);
    const analysisResult = await this.#analyzer.analyze(
      scan.files.map((file) => ({
        workspaceId: this.workspaceId,
        relativePath: file.relativePath,
        source: file.source,
        revision,
      })),
      { workspaceId: this.workspaceId, revision, projectName: basename(this.workspaceRoot) },
    );
    this.publishStatus("resolving", scan.files.length, scan.files.length);
    return normalizeAnalysisResult(
      analysisResult,
      this.workspaceId,
      revision,
      scan.files,
    );
  }

  private async waitForWatcherReady(): Promise<void> {
    await this.#watcherReadyPromise;
    if (this.#watcherReadyError !== undefined) throw this.#watcherReadyError;
    if (!this.#watcherReady) throw new Error("Filesystem watcher closed before becoming ready.");
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
    const revision = this.#fullSnapshot.revision + 1;
    try {
      this.publishStatus("scanning", 0, changedPaths.length, "Applying filesystem changes");
      const matcher = await buildIgnoreMatcher(this.workspaceRoot);
      const changedSources = new Map<string, ScannedSource>();
      const removedPaths = new Set<string>();
      const diagnostics: Array<{ relativePath?: string; message: string }> = [];

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
        else changedSources.set(relativePath, source);
      }

      if (changedSources.size === 0 && removedPaths.size === 0) {
        this.publishStatus(
          "ready",
          0,
          0,
          undefined,
          this.#status.lastIndexedAt === undefined
            ? {}
            : { lastIndexedAt: this.#status.lastIndexedAt },
        );
        return;
      }

      const affectedPaths = this.collectAffectedPaths(
        new Set(changedPaths),
        changedSources.values(),
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
        else affectedSources.set(relativePath, source);
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
        { workspaceId: this.workspaceId, revision, projectName: basename(this.workspaceRoot) },
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
      this.events.publish("graph.delta", delta);
      this.publishStatus("ready", changedPaths.length, changedPaths.length, undefined, {
        lastIndexedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Incremental indexing failed.";
      this.database.audit(this.workspaceId, "index", "incremental", "fallback", { message });
      this.#forceFullReason = `Incremental reconciliation fallback: ${message}`;
      this.#queued = true;
    } finally {
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
      const file = await readWorkspaceTextFile(this.workspaceRoot, relativePath);
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
        (error instanceof Error && /binary files/i.test(error.message))
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
  ): Set<string> {
    const affected = new Set(changedPaths);
    const nodeById = new Map(this.#fullSnapshot.nodes.map((node) => [node.id, node]));
    const changedNodeIds = new Set(
      this.#fullSnapshot.nodes
        .filter((node) => changedPaths.has(node.relativePath))
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
    for (const source of changedSources) {
      for (const hint of extractReferenceHints(source.source)) hints.add(hint);
    }
    if (hints.size > 0) {
      const referenceHints = [...hints];
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
    extra: Pick<IndexStatus, "lastIndexedAt"> = {},
  ): void {
    this.#status = {
      phase,
      completed,
      total,
      revision: this.#fullSnapshot.revision,
      ...(message === undefined ? {} : { message }),
      ...(extra.lastIndexedAt === undefined ? {} : { lastIndexedAt: extra.lastIndexedAt }),
    };
    const progress = total === 0 ? 0 : completed / total;
    this.events.publish("index.progress", {
      phase: phase === "idle" ? "scanning" : phase,
      completed,
      total,
      ...(message === undefined ? {} : { message }),
      index: {
        phase,
        progress,
        filesIndexed: completed,
        symbolsIndexed: this.graph.nodeCount,
        edgesIndexed: this.graph.edgeCount,
        ...(message === undefined ? {} : { message }),
      },
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.finishWatcherReadyWait();
    await this.#watcher?.close();
    this.#watcher = undefined;
    await this.#active;
    await this.#analyzer.close();
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
  if (left.files.length !== right.files.length) return false;
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
  for (const pattern of [javascript, python]) {
    for (const match of source.matchAll(pattern)) {
      const value = match[1]?.replaceAll(".", "/").replace(/^\/+/, "");
      if (value) hints.add(value);
    }
  }
  return [...hints];
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
    truncated: false,
  };
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
): { snapshot: GraphSnapshot; diagnostics: unknown[] } {
  const candidate = result as { snapshot?: unknown; diagnostics?: unknown[] };
  const snapshotInput = candidate.snapshot ?? result;
  const parsed = GraphSnapshotSchema.safeParse(snapshotInput);
  if (parsed.success) {
    const nodes = parsed.data.nodes.map((node) => ({ ...node, revision }));
    const edges = parsed.data.edges.map((edge) => ({ ...edge, revision }));
    return {
      snapshot: GraphSnapshotSchema.parse({
        ...parsed.data,
        protocolVersion: PROTOCOL_VERSION,
        workspaceId,
        revision,
        nodes,
        edges,
        truncated: false,
        cursor: undefined,
      }),
      diagnostics: candidate.diagnostics ?? [],
    };
  }

  // A degraded file graph keeps the dashboard useful if a native parser fails.
  return {
    snapshot: createFallbackSnapshot(workspaceId, revision, files),
    diagnostics: [
      ...(candidate.diagnostics ?? []),
      { message: "Language analyzers returned no valid snapshot; file-only graph was used." },
    ],
  };
}

function createFallbackSnapshot(
  workspaceId: string,
  revision: number,
  files: readonly ScannedSource[],
): GraphSnapshot {
  const projectId = stableId("node", workspaceId, "project");
  const project: GraphNode = {
    protocolVersion: PROTOCOL_VERSION,
    id: projectId,
    kind: "project",
    name: basename(workspaceId),
    qualifiedName: workspaceId,
    relativePath: ".",
    language: "unknown",
    revision,
    metadata: { degraded: true },
  };
  const nodes: GraphNode[] = [project];
  const edges: GraphEdge[] = [];
  for (const file of files) {
    const id = stableId("node", workspaceId, "file", file.relativePath);
    nodes.push({
      protocolVersion: PROTOCOL_VERSION,
      id,
      kind: "file",
      name: basename(file.relativePath),
      qualifiedName: file.relativePath,
      relativePath: file.relativePath,
      language: file.language,
      revision,
      metadata: { contentHash: file.contentHash },
    });
    edges.push({
      protocolVersion: PROTOCOL_VERSION,
      id: stableId("edge", projectId, id, "contains"),
      source: projectId,
      target: id,
      relation: "contains",
      confidence: "extracted",
      evidence: [],
      revision,
      metadata: {},
    });
  }
  return GraphSnapshotSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    workspaceId,
    revision,
    nodes,
    edges,
    truncated: false,
  });
}
