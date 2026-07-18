# Errores y limitaciones conocidas

Actualizado para `v0.0.3` el 2026-07-17.

## KI-001 — Cuota de OpenAI insuficiente

- Estado: abierto, dependencia externa; mitigado funcionalmente.
- Impacto: Ask OpenAI no puede generar una respuesta con la cuenta configurada,
  pero Constelix descarta cualquier texto parcial y completa la misma consulta
  mediante Ask Local.
- Evidencia: la API respondió `insufficient_quota` durante el smoke test real.
- Mitigación: habilitar facturación o cuota para recuperar respuestas generadas.
  Ask Local, el fallback, streaming y las rutas de evidencia están cubiertos por
  pruebas automatizadas.

## KI-003 — Chunks web grandes

- Estado: abierto, rendimiento.
- Impacto: Vite emite advertencias de tamaño por los workers y recursos de Monaco y ELK. No se observaron errores funcionales en E2E.
- Mitigación: mantener carga diferida y evaluar separación adicional de idiomas/workers antes de una distribución pública.

## KI-004 — Carrera TOCTOU residual entre procesos del mismo usuario

- Estado: abierto, riesgo aceptado del modelo local.
- Impacto: aunque Constelix vuelve a validar rutas inmediatamente antes de una escritura atómica, otro proceso hostil bajo la misma cuenta de macOS podría intentar cambiar enlaces o rutas en la ventana restante.
- Mitigación: usar Constelix únicamente en una máquina y repositorios
  confiables. El descriptor canónico se revalida antes de scanner, indexer, Ask,
  PTY, Codex y escrituras atómicas, además de un monitor periódico. El MVP no
  pretende aislar procesos mutuamente hostiles del mismo usuario.

## KI-005 — Plataforma y terminal de solo lectura

- Estado: limitación técnica aceptada.
- Impacto: v0.0.3 soporta únicamente macOS; la terminal segura de Modo Lectura
  depende de `/usr/bin/sandbox-exec`.
- Mitigación: Constelix falla cerrado con
  `READ_ONLY_TERMINAL_UNAVAILABLE` si ese mecanismo no existe. Otras
  plataformas permanecen fuera del alcance de esta versión.

## KI-006 — Presupuesto de indexación predeterminado

- Estado: limitación técnica aceptada y visible.
- Impacto: el índice semántico omite contenido después de 10.000 archivos
  elegibles, 2 MiB por archivo o 2 MiB agregados; el proyecto sigue disponible
  para navegación y terminal, pero el grafo puede ser parcial.
- Mitigación: onboarding, progreso y bootstrap enumeran omisiones y advierten
  el truncamiento. El benchmark interno usa un override explícito únicamente
  para validar el presupuesto de rendimiento de 10.000 archivos.

## Estado de pruebas

No hay fallos conocidos en typecheck, las 185 pruebas Vitest, los nueve
escenarios Playwright, el build, el benchmark ni el smoke del CLI empaquetado
ejecutados con Node.js 24.14.0. El benchmark registró 53.120 ms de indexación
fría, 155 ms p95 de actualización incremental y 0 ms p95 redondeado de latencia
PTY. La inspección visual del dashboard compilado abrió el fixture monorepo con
11 nodos visibles y sin errores de consola. El smoke real de Codex CLI 0.144.5
fue validado en v0.0.2; para v0.0.3 su protocolo y sandbox se validaron con
dobles automatizados, sin iniciar otro turno real. Las limitaciones abiertas
anteriores permanecen y no se considera que el producto esté libre de errores
hasta resolverlas o aceptarlas formalmente.
