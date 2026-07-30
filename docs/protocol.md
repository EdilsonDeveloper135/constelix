# Local protocol v1

Constelix uses authenticated JSON over REST for commands and snapshots, an
authenticated event WebSocket for graph deltas, index progress, PTY bytes, Ask
streaming, and Codex events, and a separate authenticated WebSocket for LSP
JSON-RPC.

Every Constelix REST body and event includes `protocolVersion: 1` and is
validated with the schemas from `@constelix/contracts`. LSP frames remain
standard JSON-RPC 2.0 messages.

## Bootstrap

The CLI opens `/#token=<capability>`. The dashboard stores the token in memory, removes the fragment with `history.replaceState`, and sends it as a bearer credential. Static assets are public on loopback; `/api/v1/*` is protected.

The dashboard opens `/api/v1/events?token=<capability>`. Before completing the
WebSocket upgrade, the agent validates that query token together with the exact
`Origin` and `Host` for the active loopback endpoint. A missing or invalid token
is rejected during the HTTP handshake, so no anonymous transient socket exists.
After a successful upgrade the server sends `connection.ready`. The former
authenticate-as-first-message flow and legacy flattened messages are rejected.

## Workspace sessions

Bootstrap returns a `session` containing a UUID `id`, the stable 24-character
`workspaceId`, and `activatedAt`. The browser sends the UUID in
`X-Constelix-Workspace-Session` on workspace-scoped REST requests and as the
`session` query parameter on the LSP WebSocket. This is a consistency boundary,
not an authentication credential: the capability token remains mandatory.
Missing, malformed, and stale sessions are rejected. Health, bootstrap, and
the authenticated global workspace controls are the only REST surfaces that do
not require the session header.

A request carrying an obsolete session fails with
`WORKSPACE_SESSION_CHANGED` and includes the current public session. This keeps
a late response from workspace A from mutating workspace B after a hot swap.
Workspace-scoped server events carry top-level `sessionId` and `workspaceId`;
the browser ignores events that do not match its active session. While a new
session is pending, it rejects all scoped commands and events. A bootstrap may
then omit the obsolete session header, but its response is still bound to the
transport generation that initiated it. The global `workspace.changed` event
carries the newly activated session.

## Workspace discovery and activation

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/workspaces` | Return the active session and up to 12 recent workspaces with summarized paths, last mode, and availability. |
| `GET /api/v1/fs/browse` | List readable directories for a local absolute path. Supports `showHidden`, `limit`, and an opaque `cursor`. |
| `POST /api/v1/workspaces/open` | Activate a path or a recent-workspace ID without reloading the dashboard. |

The directory browser defaults to the user's home directory, hides dot-prefixed
entries, returns folders rather than files, and caps each page at 200 entries.
Pagination cursors are signed and bound to the canonical directory and hidden
file setting. They also include a signed hash of the sorted directory listing,
so adding, removing, or renaming an entry invalidates the cursor instead of
silently skipping a folder. `truncated: true` always includes a cursor, and the
dashboard appends and de-duplicates pages on explicit request. Clients must not
construct or reuse cursors for another directory.
Candidate metadata inspection is separately budgeted per page, so a directory
with many entries cannot force an unbounded number of canonicalization and
workspace-detection operations in one request.

An open request includes `requestId`, `expectedSessionId`, and exactly one
target:

```json
{
  "protocolVersion": 1,
  "requestId": "uuid",
  "expectedSessionId": "uuid",
  "target": { "kind": "path", "path": "/absolute/project" }
}
```

The agent canonicalizes and validates the target, creates and starts a candidate
runtime, atomically makes it current, detaches the previous runtime, releases
the switch barrier, and then emits `workspace.changed`. A failed candidate is
closed and the previous workspace remains active. The public notification is
emitted only after the old runtime has been detached, and the successful
response contains both the
new session and its bootstrap snapshot from the same activation. The browser
quarantines scoped operations until that snapshot is validated and hydrated;
validation, the synchronous Zustand update, and transport confirmation form one
operation. A superseded response cannot replace a newer pending session. The
browser never combines a switch response with a later independent bootstrap.
Only one switch may run at a time. See
[Workspace lifecycle](workspace-lifecycle.md) for resource and lock semantics.

`WORKSPACE_LOCK_CONFLICT` may include a public conflict object. An active owner
cannot be forced. An ambiguous owner may be retried only with
`lockResolution.action: "force-release"`, the exact observed `expectedLockId`,
and `acknowledgeRisk: true`; a changed owner makes the retry fail closed.

## Bootstrap reconciliation

`GET /api/v1/bootstrap` is the authoritative reconnect snapshot. It returns the
active workspace session, the bounded graph, saved layout, conversation, active
Ask turn IDs, the active Act task when one exists, recoverable terminal
sessions, index status, and current capabilities. Public LLM state can include
its base URL, model, provider kind,
whether a key is configured or required, and the key source; it never includes
the key value. The workspace descriptor includes a stable ID, summarized path,
`mode: "read" | "edit"`, and the equivalent `readOnly: boolean`. Clients reject
inconsistent mode/boolean combinations. A bounded summary reports detected project types,
languages, estimated/indexed files, warnings, and omitted files. Live events
that arrive after a bootstrap request take precedence over that response. A
workspace change aborts active reconciliation; if a response still arrives,
its stale transport generation is rejected before hydration. A tab that missed
the event learns the current public session from `WORKSPACE_SESSION_CHANGED`,
enters quarantine, and retries bootstrap without the obsolete session header.

The production scanner defaults to 10,000 eligible files, 2 MiB per file, and
2 MiB of aggregate source content. Files beyond those bounds are omitted from
the semantic index and reported through the summary instead of failing silently.
The reproducible 10,000-file performance benchmark uses an explicit internal
aggregate-budget override; the CLI does not expose that override.

Public Act task payloads contain only the typed `ActTask` contract. Internal
fields such as the canonical `workspaceRoot` are never serialized; the scope
uses the same summarized path exposed by bootstrap.

## Revisions

Each committed index update increments the workspace revision. `GraphDelta.previousRevision` must match the client's revision; otherwise the client discards the delta and requests a fresh bootstrap. Snapshots and queries may be paginated; `truncated: true` can mean either more pages exist or the source index reached a configured safety limit.

## Streaming channels

- `index.progress`: scanning, parsing, resolving, persistence, counts, project
  summary updates, and completion.
- `graph.snapshot`: bounded provisional or committed graph views.
- `graph.delta`: revisioned semantic changes.
- `terminal.output` and `terminal.exit`: PTY lifecycle.
- `ask.event`: explicit `local`/`openai` mode, tool evidence, text deltas,
  canonical completion, typed local results, quota fallback, and errors.
- `capabilities.updated`: asynchronous Ask provider state and Codex compatibility
  results; either capability family may update independently.
- `act.event`: approved task lifecycle and Codex activity.
- `workspace.changed`: the new active session after a successful hot swap.

Every server event uses
`{ protocolVersion, eventId, timestamp, sessionId?, workspaceId?, type, payload }`.
REST bodies, WebSocket messages, and responses are validated at their boundary
with shared Zod contracts.

## Language Server Protocol

The dashboard connects to
`/api/v1/lsp?token=<capability>&session=<uuid>&language=<language>`, where
`language` is `javascript`, `typescript`, or `python`. The HTTP upgrade applies
the same exact token, `Origin`, and `Host` checks as the event socket. Browser
frames are strict JSON-RPC 2.0 messages; the agent adds and parses the
byte-counted `Content-Length` framing used by LSP over stdio.

JavaScript and TypeScript share one
[`typescript-language-server`](https://github.com/typescript-language-server/typescript-language-server)
process family. Python uses
[`pyright`](https://github.com/microsoft/pyright). The dashboard registers
Monaco diagnostics, completion, hover, definition, and reference providers.
Availability is reported per language in bootstrap, so a missing server degrades
the editor without disabling the rest of Constelix. The bridge follows
[LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/).

The browser uses `constelix://<workspaceId>/<relative-path>` document URIs.
Raw `file:` URIs from the browser are rejected. The agent canonicalizes every
mapped path, rejects workspace escape, converts contained server URIs back to
the Constelix scheme, and suppresses external file locations. Client messages,
server messages, headers, queued stdin, and pending WebSocket output are
bounded. The bridge accepts only initialize, document synchronization,
completion, hover, definition, references, and cancellation; it does not expose
server commands or arbitrary workspace methods. During initialize the agent
replaces every client root with the canonical active workspace. TypeScript uses
the packaged trusted `tsserver`, with plugins and automatic type acquisition
disabled. Monaco's built-in language features remain available as a local
fallback if the supervised process cannot start. Only one active socket per
server family is allowed; disconnect, workspace switch, or agent shutdown
terminates its child process, escalating from `SIGTERM` to `SIGKILL` after a
short timeout.

## Panel placement and layout

Editor and Assistant can be docked on the right and Terminal can be docked at
the bottom. Docked panels render in viewport chrome outside React Flow, so pan,
zoom, fit-view, and semantic relayout do not transform them. Floating placement
remains available for every tool and keeps the prior canvas interaction model.
The layout contract persists each panel's placement, active dock tab, floating
size, resource, and visibility. Semantic graph positions remain a separate
concern and do not move when a fixed responsive dock is toggled.

Opening a semantic node's context menu is non-executing. A terminal is created
only after the client sends the existing terminal request from an explicit
menu action.

## LLM configuration

Authenticated `GET /api/v1/settings/llm` returns only the public configuration.
Authenticated `PUT /api/v1/settings/llm` accepts `protocolVersion`, `baseUrl`,
`model`, and a write-only key operation: `preserve`, `replace`, or `clear`. A
replacement includes the new value only in the request; no response, bootstrap,
event, database row, or log contains it.

Agent-entered credentials are stored outside the repository and SQLite in a
private `0600` file, transactionally paired with the provider URL through a
random identifier. A provider change with `preserve` deletes the prior stored
credential instead of forwarding it. The Settings form blocks writes while its
initial configuration is loading or failed, and exposes an explicit retry.

Defaults are `https://api.openai.com/v1` and `gpt-4o`. Remote endpoints require
HTTPS and a key. A key is optional only when the URL host is `localhost`,
`127.0.0.1`, or `::1`; `http://localhost:11434/v1` supports an Ollama-compatible
server. URLs with embedded credentials, query strings, fragments, unsupported
schemes, or cleartext remote hosts are rejected. Changes replace the active
provider configuration without exposing the previous credential.

## Ask modes

Ask is always available. With no usable LLM configuration, `started.mode` is `local` and
`completed.localResult` contains bounded symbol hits, signatures, relative
paths, snippets, and depth-one relations. These results are structural search,
not generated natural-language reasoning.

When a generated turn fails with `INSUFFICIENT_QUOTA`, `INVALID_API_KEY`,
`RATE_LIMITED`, or `NETWORK_UNAVAILABLE`, the agent emits a `fallback` event
with `discardPartial: true`, switches the same turn to Local, and completes it
without duplicating the user's message or losing prior conversation history.
The notice remains visible and actionable. Quota, rate-limit, connectivity, and
provider-timeout failures may retry the configured provider on the next turn;
an invalid key remains Local until configuration changes. Failures against an
Ollama URL instruct the user to verify that Ollama and the configured model are
available on the selected port. Partial remote output is not persisted as a
completed answer.

## Terminal output recovery

`terminal.output` events include a monotonically increasing `sequence` per PTY session. The agent retains up to 256 KiB of recent output so a panel can recover bytes emitted while the terminal was being created or while its listener was reconnecting.

An authenticated `GET /api/v1/terminals/:id/output?after=<sequence>` returns the available chunks, `latestSequence`, and a `truncated` flag. The dashboard hydrates this snapshot before applying buffered live events and discards duplicate sequence numbers.

Terminal session payloads expose `cwd` relative to the workspace. In read mode,
the agent wraps the shell in a filesystem-write-denying macOS sandbox; if that
sandbox is unavailable, terminal creation fails with
`READ_ONLY_TERMINAL_UNAVAILABLE`.

## v0.0.5 limitations

- One agent process owns one active workspace. Switching is sequential rather
  than a simultaneous multi-repository view.
- Switching closes the old workspace's terminals, LSP processes, watcher, Ask
  work, and Codex process. Terminal processes are not resumed.
- Unsaved editor drafts can be kept per workspace only for the lifetime of the
  current browser page; they are not durable crash recovery.
- The local folder browser is a Constelix dialog, not the native macOS picker.
  It lists directories only and intentionally returns absolute paths to the
  authenticated local dashboard.
- LSP support is limited to JS/TS and Python. v0.0.5 does not expose rename,
  code actions, formatting, workspace symbols, semantic tokens, or other
  language servers.
