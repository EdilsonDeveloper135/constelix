# @constelix/agent

The macOS CLI and loopback agent for
[Constelix](https://github.com/EdilsonDeveloper135/constelix), a local-first
visual workspace for exploring, editing, asking about, and acting on
JavaScript, TypeScript, and Python repositories.

## Install

Constelix requires Node.js 24 on macOS:

```bash
npm install --global @constelix/agent
constelix /absolute/path/to/a/project
```

The agent binds only to loopback, serves the bundled dashboard, and requires an
ephemeral capability for every REST and WebSocket operation. See the
[project README](https://github.com/EdilsonDeveloper135/constelix#readme) for
the full workflow, security boundaries, and development instructions.
