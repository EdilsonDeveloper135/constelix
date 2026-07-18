# Local threat model

## Trust boundaries

1. The browser is an untrusted client until it proves possession of the per-process capability token.
2. The local agent owns filesystem, process, database, OpenAI, and Codex access.
3. Repository contents are untrusted input to parsers and AI.
4. Ask mode may transmit explicitly selected snippets to OpenAI.
5. Act mode can execute code and access the network after the user approves a turn.
6. A manual terminal is an explicit user-controlled process; read-only terminals
   receive an additional macOS filesystem-write sandbox.

## Enforced controls

- Bind only to `127.0.0.1`.
- Require bearer authentication for REST and an authenticated first WebSocket message.
- Compare `Origin` and `Host` with the active local endpoint.
- Canonicalize the workspace before deriving its 24-character ID or lock, capture
  its device/inode identity, and stop operational services if that identity changes.
- Propagate that descriptor through scanner, indexer, Ask, PTY, and Codex, and
  revalidate it immediately before filesystem reads or process execution.
- Reject traversal, NUL bytes, absolute request paths, and symlinks escaping the workspace.
- Detect write permission and propagate an explicit `read` or `edit` mode through
  bootstrap, editor, terminal, and Act gates.
- Use optimistic hashes and atomic renames for editor writes.
- Keep SQLite, locks, layouts, conversations, and audit data in a per-workspace
  Application Support directory outside the opened repository.
- Exclude environment files, credentials, keys, dependencies, binaries, and generated outputs from automatic AI context.
- Never expose `OPENAI_API_KEY` through bootstrap, events, SQLite, or logs.
- Redact the canonical workspace root and home directory from public errors and
  events, including equivalent macOS `/var`/`/private/var` and
  `/tmp`/`/private/tmp` aliases; expose only relative or summarized paths.
- Keep Ask Local available without credentials. If OpenAI reports insufficient
  quota, discard partial remote text and finish that same turn locally.
- Sanitize PTY and Codex child environments with an allowlist. Read-only PTYs
  are launched through `sandbox-exec` with filesystem writes denied.
- Give Codex no additional writable roots and reject escalation beyond the workspace.
- Expire Act approvals at completion, cancellation, or 15 minutes of inactivity.

## Accepted residual risk

Act mode has network access by product decision. A malicious trusted repository may attempt to influence an agent into disclosing readable host data or performing an external side effect. The MVP therefore marks Act as suitable only for repositories the user trusts, sanitizes inherited environment variables, records a local audit trail, and requires a fresh approval for every turn.

Filesystem containment is designed for accidental traversal and repository-controlled symlinks, not for a second hostile process running as the same macOS user. Constelix revalidates canonical parents immediately before atomic writes, but Node.js does not expose a portable descriptor-relative rename API that completely removes the final path-check/write race. Do not open a workspace concurrently controlled by an untrusted local process.

The read-only PTY depends on the macOS `sandbox-exec` facility. Constelix fails
closed if it is unavailable, but this control is defense in depth rather than a
replacement for operating-system account isolation.
