# Auditoría técnica de Constelix v0.0.6

Fecha de cierre: 2026-08-01. Alcance: todo el monorepo, su árbol de
dependencias bloqueado, configuración de CI/build, frontend, agente local,
persistencia, filesystem, procesos hijo, protocolo, LSP, Ask, Codex, pruebas,
empaquetado y documentación de versión.

## Resultado ejecutivo

La versión queda alineada con sus objetivos local-first y con las funciones
heredadas de v0.0.5: grafo JS/TS/Python, workspaces dinámicos, editor y PTY,
LSP local, Ask con fallback, Act con aprobación, persistencia aislada y CLI
empaquetado. No quedan hallazgos críticos o altos abiertos conocidos dentro del
modelo de amenazas declarado.

La auditoría corrigió tres clases de riesgo alto: posible entrega del token a
un origen de desarrollo arbitrario, persistencia accidental del token de
WebSocket mediante logging de URL y 23 avisos de dependencias de producción
(5 altos, 14 moderados y 4 bajos). También cerró agotamiento de recursos por
archivos/directorios/sockets sin límite, carreras de lectura, archivos privados
inseguros, validaciones laxas, cabeceras web incompletas y una incompatibilidad
de build con Monaco 0.56. `pnpm audit --prod` termina con cero vulnerabilidades
conocidas.

## Arquitectura e integración verificadas

| Capa | Responsabilidad verificada | Fronteras principales |
| --- | --- | --- |
| `apps/web` | React, React Flow, Monaco, xterm, Zustand, selector y docks | Contratos Zod recibidos, token solo en memoria, REST/WS de loopback |
| `apps/agent` | CLI, Fastify, SQLite, scanner/indexer, filesystem, PTY, LSP, Ask y Codex | Capability, sesión activa, descriptor de workspace, presupuestos y auditoría |
| `packages/contracts` | Esquemas y tipos del protocolo v1 | Validación de cuerpos, eventos, rutas, hashes, estados y capacidades |
| `packages/analyzers` | Extracción Tree-sitter JS/TS/Python | Solo recibe fuentes ya contenidas, acotadas y saneadas por el agente |
| `packages/graph-core` | Integridad, orden, consultas, deltas, paths y páginas | Revisiones monotónicas y endpoints de aristas existentes |
| Estado local | SQLite, catálogo, settings, clave LLM y leases | Fuera del repositorio, directorios `0700`, archivos privados `0600` |
| Procesos | PTY, LSP y Codex App Server | Argumentos sin shell, entorno allowlist, lifecycle por sesión y límites de I/O |

Se trazaron las rutas REST y WebSocket desde la UI hasta el runtime capturado.
El cambio de workspace conserva el patrón prepare/commit/cleanup y rechaza
tráfico de sesiones antiguas. SQL usa sentencias preparadas; no se encontraron
sinks DOM peligrosos, `eval`, `shell: true`, interpolación de comandos ni
credenciales versionadas.

## Hallazgos corregidos

### SEC-001 — Token enviado a un origen de desarrollo arbitrario (alto)

- Ubicación: `apps/agent/src/cli.ts`.
- Riesgo: `CONSTELIX_WEB_ORIGIN` podía dirigir el fragmento con la capability a
  un host controlado por terceros.
- Corrección: se acepta únicamente un origen HTTP loopback exacto
  (`127.0.0.1`, `localhost` o `::1`), sin credenciales, path, query ni fragmento;
  el mismo origen validado configura CORS y el lanzamiento.
- Prueba: orígenes locales válidos y orígenes remotos o ambiguos rechazados.

### SEC-002 — Persistencia del token de upgrade en logs (alto)

- Ubicación: `apps/agent/src/server.ts`.
- Riesgo: habilitar request logging en Fastify registraba
  `/api/v1/events?token=...` o `/api/v1/lsp?token=...`.
- Corrección: logging HTTP deshabilitado de forma explícita y documentada. La
  auditoría funcional sigue en SQLite con códigos, categorías y rutas de API,
  nunca con URLs crudas ni secretos.
- Prueba: el logger del servidor es no-op y las respuestas/redacciones no
  contienen la clave ni la capability.

### DEP-001 — Dependencias de producción vulnerables (alto)

- Ubicación: manifiestos, `pnpm-workspace.yaml` y `pnpm-lock.yaml`.
- Riesgo: advisories en `fast-uri`, `find-my-way`, `@fastify/static`,
  `brace-expansion` y DOMPurify transitivo.
- Corrección: Fastify 5.11, `@fastify/static` 10.1.2, Monaco 0.56 y overrides
  mínimos por rango hacia versiones parcheadas. No se añadieron dependencias
  runtime innecesarias.
- Verificación: instalación congelada y `pnpm audit --prod` sin vulnerabilidades.

### SEC-003 — Lecturas y escrituras de archivos no suficientemente acotadas (medio)

- Ubicación: `apps/agent/src/files.ts`, `scanner.ts` e `indexer.ts`.
- Riesgo: crecimiento entre `stat` y `readFile`, binarios o UTF-8 malformado,
  symlink swaps y carga completa de un archivo existente durante un guardado.
- Corrección: apertura `O_NOFOLLOW`, máximo `+1`, verificación de archivo
  regular, dispositivo/inodo y metadatos iniciales/finales, UTF-8 fatal y NUL
  rechazado. El guardado compara SHA-256, limita original y contenido nuevo,
  escribe temporal `wx`, conserva solo `0o777` y renombra atómicamente.
- Pruebas: archivos grandes, malformados, binarios, mutados, conflicto,
  read-only, symlinks, identidad del root y bits setuid/setgid.

### PERF-001 — Recorridos de directorio sin presupuesto global (medio)

- Ubicación: `apps/agent/src/scanner.ts` y `workspace-browser.ts`.
- Riesgo: directorios extremadamente grandes podían acumular `Dirent` sin
  límite y agotar memoria antes de alcanzar el límite de archivos elegibles.
- Corrección: `opendir` en streaming, 100.000 entradas por workspace, 25.000
  por directorio del scanner y 100.000 por directorio del selector. El scanner
  descarta un directorio parcial para evitar subconjuntos dependientes del orden
  del filesystem; el selector responde `413 WORKSPACE_BROWSE_TOO_LARGE`.
- Pruebas: presupuestos bajos deterministas y mapeo HTTP estable.

### SEC-004 — Archivos auxiliares privados susceptibles a crecimiento o swap (medio)

- Ubicación: `apps/agent/src/llm-config.ts` y `workspace-lock.ts`.
- Riesgo: settings, secreto, lock o guard podían crecer durante una lectura o
  convertirse en un enlace/archivo especial.
- Corrección: tipo regular, no-follow, identidad, permisos `0600` y lecturas
  máximas de 32 KiB para configuración y 16 KiB para locks.
- Pruebas: secreto sobredimensionado, archivo no regular, permisos y reinicio.

### PERF-002 — Sockets de eventos ilimitados y sin contrapresión (medio)

- Ubicación: `apps/agent/src/events.ts`.
- Riesgo: clientes autenticados lentos o múltiples conexiones podían retener
  buffers de salida sin una política de corte.
- Corrección: máximo de ocho conexiones de eventos y 8 MiB por buffer; exceso
  cierra con códigos WebSocket recuperables y desprende el socket.
- Pruebas: novena conexión rechazada y cliente lento desconectado.

### SEC-005 — Defensa web y artefactos de producción incompletos (medio)

- Ubicación: `apps/agent/src/server.ts`, `apps/web/vite.config.ts` y
  `apps/agent/tsup.config.ts`.
- Riesgo: ausencia de CSP/anti-framing/permissions y source maps de producción
  que ampliaban información disponible ante una capability robada.
- Corrección: CSP sin `unsafe-eval`, frame ancestors y form action bloqueados,
  headers MIME/referrer/cache/resource/opener/permissions y source maps
  deshabilitados. Los workers siguen permitidos solo desde `self`/`blob`.
- Pruebas: headers sobre dashboard y ausencia de mapas JS empaquetados.

### VAL-001 — Contratos con cadenas o colecciones laxas (medio)

- Ubicación: `packages/contracts/src/index.ts`.
- Riesgo: paths y shell sin máximo/NUL, hash de escritura arbitrario y
  capacidades Act repetidas.
- Corrección: máximo de 4.096 caracteres, NUL prohibido, SHA-256 hexadecimal
  minúsculo exacto y set Act único de hasta tres capacidades.
- Pruebas: cada entrada inválida falla antes de llegar al runtime.

### REL-001 — Build roto al parchear Monaco (medio)

- Ubicación: `apps/web/src/lib/monaco.ts`.
- Riesgo: Monaco 0.56 introdujo un mapa de exports y Rolldown dejó de resolver
  los subpaths internos `esm/vs/...`.
- Corrección: imports desde los subpaths públicos exportados para editor, JSON,
  HTML, CSS y TypeScript workers.
- Verificación: typecheck, build y dashboard conectado.

### REL-002 — Análisis incompleto y scanner duplicado (bajo)

- Ubicación: `packages/analyzers/src/analyzer.ts`.
- Riesgo: funciones Python `async` y exports default anónimos no aparecían de
  forma consistente; un scanner público duplicaba una implementación menos
  segura sin consumidores internos.
- Corrección: cobertura Tree-sitter ampliada y eliminación segura del scanner
  obsoleto y de su API privada no usada.
- Pruebas: símbolos async/default, resolución e integridad del snapshot.

### REL-003 — Coste repetido y aristas colgantes en páginas (bajo)

- Ubicación: `packages/graph-core/src/index.ts`.
- Riesgo: el orden conectado se recalculaba en cada snapshot y una página podía
  exponer una arista cuyo endpoint no estaba incluido.
- Corrección: cache invalidada en `replace`/`applyDelta`, `Set` para nodos
  eliminados y aristas de página solo cuando ambos endpoints están presentes.
- Pruebas: páginas autocontenidas, deltas, truncamiento y mutaciones.

### REL-004 — Hidratación tardía podía pisar un borrador de Settings (medio)

- Ubicación: `apps/web/src/components/shell/SettingsModal.tsx`.
- Riesgo: una actualización de estado de baja prioridad programada antes del
  input podía aplicarse después y restaurar `gpt-4o` sobre el modelo escrito.
- Corrección: inicialización en layout y actualizadores funcionales que vuelven
  a consultar el flag dirty en el instante de aplicar, no solo al programarse.
- Pruebas: flujo conectado completo y diez repeticiones consecutivas del caso
  de configuración tardía con edición simultánea.

### UX-001 — Acciones inertes y tooltips no accesibles (bajo)

- Ubicación: `apps/web/src/components/shell/Rail.tsx` y `styles.css`.
- Riesgo: Ayuda parecía ejecutable sin hacer nada y la navegación compacta no
  explicaba sus iconos a usuarios de mouse/teclado.
- Corrección: Ayuda deshabilitada con estado “Próximamente”, nombres accesibles,
  tooltips en hover/foco y transiciones limitadas compatibles con reduced motion.

## Rendimiento y calidad

- El orden conectado del grafo se reutiliza hasta una mutación.
- Scanner, browser, editor, locks, settings, eventos, LSP, PTY e indexador tienen
  presupuestos explícitos y fallos recuperables.
- Monaco y xterm se cargan de forma diferida. Vite aún avisa sobre chunks
  diferidos grandes de Monaco/TypeScript/ELK; no se elevó artificialmente el
  umbral para ocultarlo.
- No existe un comando lint separado en el proyecto. La puerta equivalente es
  TypeScript estricto, Vitest, build, `git diff --check`, E2E y smokes.

## Verificación ejecutada

- Node.js 24.14.0 y pnpm 11.9.0 del runtime reproducible del workspace.
- `pnpm install --frozen-lockfile`: correcto.
- `pnpm typecheck`: correcto en los cinco proyectos compilables.
- Vitest: 42 archivos y 309 pruebas correctas.
- `pnpm build`: correcto; dashboard, agente y assets CLI empaquetados.
- `pnpm audit --prod`: cero vulnerabilidades conocidas.
- Playwright: 17 de 17 escenarios correctos en Chromium; el caso de hidratación
  de Settings pasó además 10 repeticiones consecutivas.
- Benchmark: 10.000 archivos y 2.000.000 de líneas en 42.497 ms; actualización
  incremental p95 en 134 ms y PTY p95 en 0 ms, dentro de 90 s, 1 s y 100 ms.
- Smoke LSP: TypeScript Language Server y Pyright inicializaron, diagnosticaron
  y respondieron hover real.
- Smoke del paquete: `constelix-agent-0.0.6.tgz` se instaló y arrancó con una
  ruta que contiene espacios, sirvió el dashboard y no imprimió la capability.

## Riesgos restantes y puntos no verificables automáticamente

- Un proceso hostil bajo la misma cuenta de macOS puede competir en la última
  ventana TOCTOU de un rename o leer archivos accesibles a ese usuario. La
  frontera real es la cuenta del sistema operativo.
- LSP y una terminal manual ejecutan código/herramientas locales del usuario;
  solo deben abrirse repositorios confiables.
- Los workers diferidos de Monaco/TypeScript son grandes y aumentan el tiempo
  de primera apertura del editor en equipos lentos.
- Ask remoto depende de red, cuota y credenciales; Ask Local mantiene la función
  básica. Ollama depende del daemon/modelo local.
- El smoke real de Codex y los smokes reales de proveedores LLM son opt-in: no
  se ejecutan sin autorización por turno o credenciales externas. Sus estados,
  cancelación, aprobación, redacción y fallbacks sí se cubren con dobles.
- La plataforma soportada continúa siendo macOS; `sandbox-exec` es obligatorio
  para PTY de solo lectura.
