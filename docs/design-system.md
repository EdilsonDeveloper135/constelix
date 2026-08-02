# Constelix visual system

This document records the approved visual concept as implementation tokens.

## Composition

- Full viewport, graphite-black world surface with a subtle dotted grid.
- 48 px top bar and 72 px left navigation rail.
- The semantic graph occupies the primary transformable field by itself.
- Editor and Assistant may dock on the right; Terminal may dock at the bottom.
- Docked tools belong to viewport chrome and remain stable during canvas pan,
  zoom, fit-view, evidence focus, and graph relayout.
- Every tool retains a floating canvas mode. Placement, active dock tab,
  visibility, and the last floating position and size persist per workspace.

## Workspace interaction

- Dock and float controls are explicit, keyboard reachable, and expose their
  action and destination through an accessible name.
- Adding or removing a dock changes the remaining canvas viewport, not semantic
  node coordinates. v0.0.6 uses fixed responsive dock dimensions. Docked Monaco
  and xterm instances remain mounted across zoom and dock-tab switches.
- Right-clicking a semantic node opens a focusable `menu`; it never executes a
  command by itself. Inspecting/selecting the node, exploring its relations,
  opening its file, or creating a terminal require an explicit selection.
- Settings is a real modal surface with labeled Base URL, Model, and write-only
  API key fields. Saving never re-renders a stored credential in the browser.
- The current workspace identity in the top bar is an explicit button. It opens
  a modal selector with filtered recents, absolute-path entry, and a keyboard
  navigable, progressively paginated local folder browser; no page reload is
  required.
- Workspace switching exposes validating and activating states, disables modal
  dismissal while activation is in progress, and blocks a switch while Act is
  running. Dirty editor drafts require an explicit preserve, discard, or cancel
  choice. Ambiguous locks require a separate destructive confirmation; an
  active lock never offers force release.
- Dialogs and context menus trap focus while open, close with Escape, and return
  focus to their trigger.

## Tokens

| Role | Value |
| --- | --- |
| World | `#090d0f` |
| Grid | `rgba(128, 151, 154, 0.10)` |
| Chrome | `#0d1214` |
| Surface | `#111719` |
| Elevated | `#151c1f` |
| Border | `#354044` |
| Border strong | `#667277` |
| Text | `#edf2f1` |
| Muted | `#8c999c` |
| Cyan | `#36d5f2` |
| Green | `#82dc62` |
| Amber | `#f5bd4f` |
| Violet | `#bc93ff` |

UI chrome uses Inter/system sans. Code, graph labels, paths, statuses, and terminal content use Berkeley Mono/SFMono-compatible fallbacks. Corners remain compact (4–8 px); borders are more important than shadows. Motion is short and functional: 140 ms for controls, 220 ms for panels, and 360 ms per highlighted graph hop.
