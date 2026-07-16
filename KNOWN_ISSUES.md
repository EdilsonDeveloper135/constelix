# Errores y limitaciones conocidas

Actualizado para `v0.0.1` el 2026-07-16.

## KI-001 — Cuota de OpenAI insuficiente

- Estado: abierto, dependencia externa.
- Impacto: el modo «Preguntar» muestra un error recuperable al intentar una solicitud real con la cuenta configurada.
- Evidencia: la API respondió `insufficient_quota` durante el smoke test real.
- Mitigación: habilitar facturación o cuota en el proyecto de OpenAI. Las herramientas, streaming y rutas de evidencia están cubiertas con proveedor simulado en las pruebas automatizadas.

## KI-003 — Chunks web grandes

- Estado: abierto, rendimiento.
- Impacto: Vite emite advertencias de tamaño por los workers y recursos de Monaco y ELK. No se observaron errores funcionales en E2E.
- Mitigación: mantener carga diferida y evaluar separación adicional de idiomas/workers antes de una distribución pública.

## Estado de pruebas

No hay fallos conocidos en typecheck, las 74 pruebas Vitest, los cuatro escenarios Playwright, el build, el benchmark ni el smoke del CLI empaquetado ejecutados con Node.js 24.14.0. Las limitaciones abiertas anteriores permanecen y no se considera que el producto esté libre de errores hasta resolverlas o aceptarlas formalmente.
