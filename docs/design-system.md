# Constelix visual system

This document records the approved visual concept as implementation tokens.

## Composition

- Full viewport, graphite-black world surface with a subtle dotted grid.
- 48 px top bar and 72 px left navigation rail.
- Semantic graph occupies the primary field.
- Code editor floats on the right, terminal at lower left, and AI panel at lower center.
- Tool panels are part of the canvas world, not modal dialogs.

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
