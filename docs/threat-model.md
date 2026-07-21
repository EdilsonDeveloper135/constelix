# Local threat model

## Trust boundaries

1. The browser is an untrusted client until it proves possession of the per-process capability token.
2. The local agent owns filesystem, process, database, LLM, and Codex access.
3. Repository contents are untrusted input to parsers and AI.
4. Ask mode may transmit explicitly selected snippets to the configured LLM.
   Loopback providers keep the request local; remote providers cross the network.
5. Act mode can execute code and access the network after the user approves a turn.
6. A manual terminal is an explicit user-controlled process; read-only terminals
   receive an additional macOS filesystem-write sandbox.

## Enforced controls

- Bind only to `127.0.0.1`.
- Require bearer authentication for REST. Validate the capability query token,
  exact `Origin`, and exact `Host` before completing a WebSocket upgrade.
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
- Treat `LLM_API_KEY`, `OPENAI_API_KEY`, and equivalent provider credentials as
  write-only at protocol boundaries. Never return or inject them through
  bootstrap, settings responses, events, SQLite, browser storage, logs, prompts,
  or child-process environments.
- Store a credential entered through Settings in a dedicated agent-owned file
  outside the repository and SQLite, with a private directory and `0600` file
  permissions. Bind the secret transactionally to its provider URL with a random
  identifier; fail closed after a partial update and delete it on provider change.
- Require HTTPS for remote LLM endpoints. Permit cleartext HTTP and a missing
  API key only for exact loopback hosts; reject embedded credentials, query
  strings, fragments, and non-HTTP schemes.
- Redact the canonical workspace root and home directory from public errors and
  events, including equivalent macOS `/var`/`/private/var` and
  `/tmp`/`/private/tmp` aliases; expose only relative or summarized paths.
- Keep Ask Local available without credentials. On insufficient quota, invalid
  credentials, rate limiting, or network failure, discard uncommitted provider
  text and finish that same turn locally without losing conversation history.
- Sanitize PTY and Codex child environments with an allowlist. Read-only PTYs
  are launched through `sandbox-exec` with filesystem writes denied.
- Give Codex no additional writable roots and reject escalation beyond the workspace.
- Expire Act approvals at completion, cancellation, or 15 minutes of inactivity.

## Accepted residual risk

A configured remote LLM receives the bounded snippets needed for a turn and is
subject to that provider's availability, retention, quota, and privacy terms.
A loopback OpenAI-compatible service avoids that network boundary but is still a
separate local process: Constelix cannot guarantee that its daemon is running,
that the named model is installed, or that every model implements the required
streaming/tool behavior. Only configure providers and local daemons you trust.

The WebSocket capability appears transiently in its in-memory connection URL so
the server can reject unauthenticated upgrades. Constelix does not write that
URL to browser history or application logs, but local browser developer tools
and a process already controlling the browser remain inside the trusted-machine
assumption.

Act mode has network access by product decision. A malicious trusted repository may attempt to influence an agent into disclosing readable host data or performing an external side effect. The MVP therefore marks Act as suitable only for repositories the user trusts, sanitizes inherited environment variables, records a local audit trail, and requires a fresh approval for every turn.

File mode `0600` prevents access by other macOS accounts, not by a hostile
process already running as the same user. A manual terminal is explicitly under
user control, while an approved Codex turn could attempt to read the agent's
credential file because workspace-write limits writes, not all host reads. The
credential is never injected into that process, but strong same-user secrecy
would require a Keychain/broker design or a deny-read sandbox beyond this MVP.
Use Act only with trusted repositories and clear stored provider keys when they
are not needed.

Filesystem containment is designed for accidental traversal and repository-controlled symlinks, not for a second hostile process running as the same macOS user. Constelix revalidates canonical parents immediately before atomic writes, but Node.js does not expose a portable descriptor-relative rename API that completely removes the final path-check/write race. Do not open a workspace concurrently controlled by an untrusted local process.

The read-only PTY depends on the macOS `sandbox-exec` facility. Constelix fails
closed if it is unavailable, but this control is defense in depth rather than a
replacement for operating-system account isolation.
