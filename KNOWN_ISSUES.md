# Errores y limitaciones conocidas

Actualizado para `v0.0.0` el 2026-07-16.

## KI-001 — Cuota de OpenAI insuficiente

- Estado: abierto, dependencia externa.
- Impacto: el modo «Preguntar» muestra un error recuperable al intentar una solicitud real con la cuenta configurada.
- Evidencia: la API respondió `insufficient_quota` durante el smoke test real.
- Mitigación: habilitar facturación o cuota en el proyecto de OpenAI. Las herramientas, streaming y rutas de evidencia están cubiertas con proveedor simulado en las pruebas automatizadas.

## KI-002 — Runtime local distinto al objetivo

- Estado: abierto para verificación de distribución.
- Impacto: el entorno usado para este checkpoint ejecuta Node.js 22, mientras el producto y su paquete exigen Node.js 24.
- Mitigación: `engines.node` impide instalaciones incompatibles y la CI usa Node.js 24. Debe confirmarse el tarball final en una máquina limpia con Node.js 24 antes de publicar.

## KI-003 — Chunks web grandes

- Estado: abierto, rendimiento.
- Impacto: Vite emite advertencias de tamaño por los workers y recursos de Monaco y ELK. No se observaron errores funcionales en E2E.
- Mitigación: mantener carga diferida y evaluar separación adicional de idiomas/workers antes de una distribución pública.

## KI-004 — Recuperación de errores tardíos del watcher

- Estado: abierto, resiliencia.
- Impacto: si Chokidar emite un error después de establecer su baseline inicial, Constelix informa el error, pero todavía no recrea automáticamente las suscripciones. El grafo puede requerir reiniciar el agente para recuperar vigilancia completa.
- Mitigación: el arranque y la primera reconciliación ya están protegidos contra cambios perdidos. Se añadirá recuperación con backoff, reconciliación completa y pruebas de error posterior a `ready`.

## Estado de pruebas

No hay fallos conocidos en la suite automatizada del checkpoint. Las limitaciones anteriores permanecen abiertas y no se considera que el producto esté libre de errores hasta resolverlas o aceptarlas formalmente.
