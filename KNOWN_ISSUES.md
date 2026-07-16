# Errores y limitaciones conocidas

Actualizado para `v0.0.2` el 2026-07-16.

## KI-001 — Cuota de OpenAI insuficiente

- Estado: abierto, dependencia externa.
- Impacto: el modo «Preguntar» muestra un error recuperable al intentar una solicitud real con la cuenta configurada.
- Evidencia: la API respondió `insufficient_quota` durante el smoke test real.
- Mitigación: habilitar facturación o cuota en el proyecto de OpenAI. Las herramientas, streaming y rutas de evidencia están cubiertas con proveedor simulado en las pruebas automatizadas.

## KI-003 — Chunks web grandes

- Estado: abierto, rendimiento.
- Impacto: Vite emite advertencias de tamaño por los workers y recursos de Monaco y ELK. No se observaron errores funcionales en E2E.
- Mitigación: mantener carga diferida y evaluar separación adicional de idiomas/workers antes de una distribución pública.

## KI-004 — Carrera TOCTOU residual entre procesos del mismo usuario

- Estado: abierto, riesgo aceptado del modelo local.
- Impacto: aunque Constelix vuelve a validar rutas inmediatamente antes de una escritura atómica, otro proceso hostil bajo la misma cuenta de macOS podría intentar cambiar enlaces o rutas en la ventana restante.
- Mitigación: usar Constelix únicamente en una máquina y repositorios confiables; mantener la canonicalización, revalidación previa al rename y sandbox de Codex. El MVP no pretende aislar procesos mutuamente hostiles del mismo usuario.

## Estado de pruebas

No hay fallos conocidos en typecheck, las 140 pruebas Vitest, los cinco escenarios Playwright, el build, el benchmark ni el smoke del CLI empaquetado ejecutados con Node.js 24.14.0. El benchmark registró 44.444 ms de indexación fría, 144 ms p95 de actualización incremental y 0 ms p95 redondeado de latencia PTY. El smoke real de Codex CLI 0.144.5 completó una escritura interna y bloqueó una escritura externa. Las limitaciones abiertas anteriores permanecen y no se considera que el producto esté libre de errores hasta resolverlas o aceptarlas formalmente.
