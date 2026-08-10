# Auditoría general y remediación — v0.0.8

Fecha: 2026-08-10
Base auditada: `v0.0.7` (`83c3e15`)
Entrega resultante: `v0.0.8`

## Resultado ejecutivo

La auditoría revisó distribución, seguridad, dependencias, CI, calidad,
compatibilidad de navegadores, rendimiento, compatibilidad Codex,
mantenibilidad y coherencia de versión. Todos los hallazgos accionables de este
alcance se corrigieron en `v0.0.8` y cuentan con una verificación automatizada o
reproducible.

Las restricciones que dependen de plataforma, proveedores externos o del
modelo de confianza local no se presentan como defectos resueltos. Permanecen
declaradas y mitigadas en `KNOWN_ISSUES.md` y `docs/threat-model.md`.

## Criterio de cierre

Un hallazgo se considera cerrado únicamente cuando:

1. la corrección vive en la frontera responsable;
2. existe una regresión automatizada o una comprobación reproducible;
3. los gates del repositorio fallan si el problema reaparece;
4. la documentación pública coincide con el artefacto distribuido.

## Hallazgos y correcciones

### REL-01 — El paquete público no estaba completo

- Riesgo: el repositorio y `@constelix/agent` no declaraban licencia ni todos
  los metadatos de procedencia; el smoke verificaba ejecución, pero no el
  contenido legal y documental del tarball.
- Corrección: licencia MIT en raíz y paquete, README específico del agente,
  `repository`, `homepage`, `bugs`, palabras clave y lista explícita de archivos
  publicables.
- Regresión: `smoke-packaged-cli.ts` inspecciona el tarball y el manifiesto
  instalado antes de arrancar el CLI.
- Estado: cerrado.

### SEC-01 — La capability REST se comparaba como texto ordinario

- Riesgo: la validación aceptaba el encabezado mediante una comparación de
  string sin reutilizar la primitiva de comparación segura del transporte.
- Corrección: el agente exige exactamente `Bearer <token>`, rechaza casing,
  prefijos o sufijos adicionales y usa comparación de longitud constante.
- Regresión: casos de token incorrecto de igual longitud, texto añadido y
  `bearer` en minúsculas.
- Estado: cerrado.

### DEP-01 — La auditoría completa encontraba vulnerabilidades transitivas

- Riesgo: el gate documentado cubría producción, pero la instalación completa
  mantenía avisos en herramientas de desarrollo y bundling.
- Corrección: actualización compatible del lockfile, override acotado de
  `esbuild`, scripts separados `audit:deps` y `audit:prod`, y job de seguridad
  en CI.
- Regresión: `pnpm audit --audit-level low` debe terminar sin vulnerabilidades
  conocidas.
- Estado: cerrado.

### CI-01 — La cadena de CI tenía menos fronteras de las necesarias

- Riesgo: acciones referenciadas solo por tags mutables y ausencia de jobs
  dedicados para auditoría, benchmark y WebKit.
- Corrección: acciones fijadas por SHA, permisos mínimos, cancelación de runs
  obsoletos, jobs separados de verificación, seguridad y rendimiento, más
  matriz E2E Chromium/WebKit. Dependabot revisa npm y GitHub Actions.
- Regresión: el workflow ejecuta instalación congelada y cada gate en Node 24 y
  pnpm 11.
- Estado: cerrado.

### QUA-01 — Las pruebas no imponían cobertura mínima

- Riesgo: una suite verde podía perder cobertura sin bloquear el checkpoint.
- Corrección: cobertura V8 de aplicaciones, paquetes y utilidades de benchmark,
  con umbrales de 60% statements, 50% branches, 54% functions y 64% lines.
  `pnpm check` usa `test:coverage`.
- Regresión: Vitest falla cuando cualquier umbral global retrocede.
- Estado: cerrado.

### BRW-01 — E2E validaba solo Chromium

- Riesgo: diferencias de interacción de Safari quedaban fuera del gate. WebKit
  demostró que el clic no siempre enfoca un botón antes de abrir un modal y que
  el bloqueo lógico de Monaco no añadía por sí solo el atributo DOM read-only.
- Corrección: proyecto Desktop Safari y matriz CI; el disparador de Ayuda toma
  foco explícitamente antes de abrir el diálogo. La misma regla cubre
  Configuración, paleta y selector, las transiciones entre modales conservan un
  disparador persistente y Monaco activa `domReadOnly` junto con `readOnly`.
- Regresión: navegación, foco, viewport, Monaco, PTY y flujos conectados se
  ejecutan tanto en Chromium como en WebKit. La ejecución local usa un worker
  porque ambos proyectos comparten un agente/proxy real; CI los separa por job.
- Estado: cerrado.

### PERF-01 — Monaco incorporaba servicios y lenguajes no utilizados

- Riesgo: el bundle incluía workers y contribuciones de HTML, CSS, JSON y
  TypeScript aunque Constelix usa un LSP propio, generando chunks innecesarios y
  warnings de Vite.
- Corrección: importación granular de `editor.api`, worker de editor y
  definiciones JS/Python/TypeScript; grupos de split separados para Monaco,
  React, canvas y estado.
- Resultado: el mayor chunk JavaScript de Monaco queda alrededor de 475 KiB y
  el build ya no emite el warning de tamaño. ELK conserva un worker diferido de
  aproximadamente 1.59 MiB que no forma parte de la carga inicial.
- Estado: cerrado; el recurso ELK residual se sigue en `KNOWN_ISSUES.md`.

### PERF-02 — Un timeout de benchmark no explicaba el estado del host

- Riesgo: distinguir una regresión real de un host saturado exigía repetir la
  prueba sin evidencia de fase o carga.
- Corrección: percentil compartido y diagnósticos de fase, progreso, revisión,
  bytes recibidos, paralelismo y load average. El watchdog de diagnóstico se
  separa del presupuesto funcional.
- Garantía: los presupuestos siguen siendo 90 s para frío, 1 s para incremental
  p95 y 100 ms para PTY p95.
- Estado: cerrado.

### CMP-01 — Actuar dependía de una única versión exacta de Codex CLI

- Riesgo: una actualización compatible deshabilitaba Actuar aunque conservara
  el protocolo requerido; una versión futura no probada podía aceptarse por
  accidente.
- Corrección: rango estricto `>=0.144.5 <0.148.0`, probado con `0.147.0`, parser
  numérico fail-closed y rechazo de prereleases.
- Regresión: límites inferior/superior, versión actual, versión antigua,
  futura y prerelease.
- Estado: cerrado.

### MNT-01 — La actualización incremental concentraba demasiadas decisiones

- Riesgo: `reindexIncrementally` y la expansión de rutas afectadas mezclaban
  escaneo, lectura, importadores, vecinos y referencias, elevando la complejidad
  de cambios futuros.
- Corrección: separación en fases y helpers tipados con un estado de escaneo
  explícito, preservando límites de memoria, fallback y semántica de revisión.
- Regresión: suite del indexador, integración de workspace y benchmark de
  10.000 archivos.
- Estado: cerrado.

### OBS-01 — El cierre esperado de sockets ocultaba señales útiles en E2E

- Riesgo: los mensajes `ECONNRESET`/`EPIPE` del proxy al cerrar un navegador
  saturaban la salida, pero silenciarlos globalmente podía esconder fallos
  reales.
- Corrección: logger de Vite que filtra solo esos cierres y únicamente bajo el
  entorno E2E.
- Regresión: prueba unitaria confirma que cualquier otro error sigue llegando
  al logger.
- Estado: cerrado.

### VER-01 — La versión del runtime estaba duplicada

- Riesgo: servidor, workspace, LSP y cliente Codex podían informar checkpoints
  distintos aunque los manifiestos coincidieran.
- Corrección: `CONSTELIX_VERSION` y `CONSTELIX_RELEASE` en contratos compartidos,
  consumidos por todas las fronteras; `version:check` los valida.
- Estado: cerrado.

## Evidencia de validación

El checkpoint se valida con Node.js 24 y pnpm 11:

- instalación congelada y auditoría completa sin vulnerabilidades conocidas;
- version check, typecheck, cobertura V8 y build de producción;
- 47 archivos Vitest y 330 pruebas unitarias/integración correctas;
- Playwright en Chromium y WebKit, incluidos foco Safari, Monaco, PTY,
  hot-swap, modo lectura, LSP y errores redactados;
- benchmark de 10.000 archivos y 2.000.000 de líneas: 40.322 ms en frío,
  127 ms incremental p95 y 0 ms PTY p95;
- smoke real de los LSP incluidos y smoke del tarball instalado;
- `git diff --check` y revisión del contenido preparado para commit.

El smoke real de Codex y los proveedores LLM permanece opt-in: puede iniciar un
turno con efectos o depender de servicios y credenciales externas. Esta
auditoría valida sus contratos, rangos, sandbox, redacción, timeouts y fallbacks
con dobles deterministas, pero no afirma haber ejecutado un turno externo.

## Riesgos residuales

Permanecen fuera del cierre:

- disponibilidad y comportamiento de proveedores LLM externos o locales;
- soporte de plataforma limitado a macOS;
- límites deliberados del índice y de los lenguajes LSP incluidos;
- estado visual no durable de Monaco/xterm al cambiar su host;
- carreras entre procesos mutuamente hostiles bajo la misma cuenta del sistema;
- lectura de secretos por un proceso ya comprometido con privilegios del mismo
  usuario.

No se detectaron hallazgos accionables abiertos dentro del alcance de esta
auditoría. Los riesgos anteriores están aceptados, visibles y mitigados en la
medida compatible con el modelo local del producto.
