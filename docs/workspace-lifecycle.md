# Workspace lifecycle and leases

v0.0.6 treats a workspace as an isolated runtime owned by
`WorkspaceRuntimeManager`. The global event bus, recent-workspace catalog, and
folder browser outlive a switch. Each workspace runtime owns its descriptor,
SQLite database, indexer/watcher, PTYs, Ask service, Codex process, LSP manager,
event bus, and lease.

## Activation

1. Resolve a path target or look up the server-only canonical root for a recent
   workspace.
2. Canonicalize the root, capture its device/inode identity, derive its stable
   workspace ID, and determine read/edit mode.
3. Validate that the global and derived per-workspace state paths remain
   outside the candidate repository, create the private state directory, and
   acquire its lease.
4. Open persistence and construct indexer, terminal, Ask, Codex, and LSP
   services. Start the watcher and schedule initial indexing.
5. Make the candidate current, record its summarized recent-workspace metadata,
   close and detach the old runtime, release the switch barrier, then emit
   `workspace.changed`.

Candidate creation is transactional. Any failure closes all candidate resources
and leaves the old runtime current. An active Act task blocks switching in the
dashboard. The browser saves layout, cancels Ask, and asks whether to preserve
or discard dirty editor drafts before activation.

The public commit occurs only after the old runtime is detached and the switch
barrier has been released. Once the candidate is current, failures while
recording recents, publishing the notification, or closing old resources are
audited and cannot roll back to a runtime already being torn down. Other
browser tabs quarantine scoped commands until they hydrate the announced
session. Reconciliation aborts on a newer workspace event, and both REST
responses and bootstrap hydration are generation-bound. The client validates
the staged session, updates its store synchronously, and only then releases
the transport quarantine. If events for the staged session arrived while it
was quarantined, the client immediately performs one authoritative bootstrap
after commit so no early graph delta is silently lost.

Dirty-draft confirmation is bound to the source workspace and session. Before
and after saving, the dashboard revalidates the transition barrier and active
Act task; discarding drafts clears only records owned by that source workspace.
Transient reconciliation never reopens onboarding unless the user explicitly
left that flow open.

Teardown is idempotent and stops Ask, Codex, PTYs, LSP, and the indexer before
closing SQLite, releasing the lease, and closing the workspace event bus.
Workspace identity and lease ownership are rechecked while active. Losing
either emits `WORKSPACE_ISOLATION_LOST` and fails closed by tearing down the
runtime.

## State ownership

Default state is stored under
`~/Library/Application Support/Constelix`:

- `global.sqlite`: the bounded recent-workspace catalog.
- `workspaces/<workspaceId>/constelix.sqlite`: graph, layouts, conversations,
  and audit data for one workspace.
- `workspaces/<workspaceId>/agent.lock`: the active v1 lease.

State directories use mode `0700`; the global catalog and lock files are
explicitly `0600`. Per-workspace SQLite files remain inside the protected state
directory. Canonical roots are retained only in server-side records. Public
recent-workspace payloads contain summarized display paths.

## Lock v1

A lease records `lockId`, PID, process boot timestamp, executable path, agent
version, workspace ID and canonical path, plus creation time. Its file mtime is
refreshed every 5 seconds as the heartbeat; 15 seconds is the default stale
threshold.

Inspection combines process liveness, executable identity, workspace identity,
heartbeat freshness, metadata validity, and file device/inode:

| Classification | Behavior |
| --- | --- |
| `missing` | Acquire normally. |
| `stale-safe` | Remove automatically under the lock guard, then acquire. |
| `active` | Reject; force release is never allowed. |
| `ambiguous` | Reject unless the user explicitly acknowledges a guarded force release. |
| `initializing` | Reject, including force, while a concurrent writer may still be creating metadata. |

Acquire, recovery, force release, and normal release are serialized with a
separate guard file. Force release is compare-and-delete: the request must name
the exact observed `lockId`, and device/inode plus owner ID are checked again
immediately before unlinking. PID liveness alone never proves ownership.
Legacy locks are accepted for inspection but remain ambiguous while their owner
may be alive.

If acquisition created a lease but cannot release its guard, it removes that
lease before reporting failure and retries guard cleanup. A candidate is never
published with uncertain guard ownership.

This lease prevents accidental concurrent Constelix ownership; it is not a
security boundary against another hostile process running as the same macOS
user.
