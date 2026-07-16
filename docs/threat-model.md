# Local threat model

## Trust boundaries

1. The browser is an untrusted client until it proves possession of the per-process capability token.
2. The local agent owns filesystem, process, database, OpenAI, and Codex access.
3. Repository contents are untrusted input to parsers and AI.
4. Ask mode may transmit explicitly selected snippets to OpenAI.
5. Act mode can execute code and access the network after the user approves a turn.

## Enforced controls

- Bind only to `127.0.0.1`.
- Require bearer authentication for REST and an authenticated first WebSocket message.
- Compare `Origin` and `Host` with the active local endpoint.
- Canonicalize paths with `realpath`; reject traversal, NUL bytes, absolute request paths, and symlinks escaping the workspace.
- Use optimistic hashes and atomic renames for editor writes.
- Exclude environment files, credentials, keys, dependencies, binaries, and generated outputs from automatic AI context.
- Never expose `OPENAI_API_KEY` through bootstrap, events, SQLite, or logs.
- Give Codex no additional writable roots and reject escalation beyond the workspace.
- Expire Act approvals at completion, cancellation, or 15 minutes of inactivity.

## Accepted residual risk

Act mode has network access by product decision. A malicious trusted repository may attempt to influence an agent into disclosing readable host data or performing an external side effect. The MVP therefore marks Act as suitable only for repositories the user trusts, sanitizes inherited environment variables, records a local audit trail, and requires a fresh approval for every turn.
