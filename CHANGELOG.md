# Changelog

## [v0.0.5] - 2026-07-29

### Added

- LSP local supervisado para TypeScript, JavaScript y Python, integrado con Monaco para diagnósticos, hover, completado y autoimports, definición, referencias y navegación entre archivos.
- Selector accesible de workspaces con recientes persistentes, explorador paginado de carpetas, apertura por ruta y cambio transaccional sin recargar el dashboard.
- Sesiones de workspace explícitas que aíslan REST, eventos, PTY, LSP, Ask, Codex, watcher y SQLite durante un cambio en caliente.
- Leases enriquecidos con identidad de proceso, ejecutable, versión, inicio, heartbeat, detección de locks obsoletos y liberación forzada mediante confirmación protegida.
- Smoke real de los servidores TypeScript y Pyright, pruebas de lifecycle A→B→A, aislamiento de respuestas antiguas y documentación del protocolo y modelo de amenazas.

### Fixed

- El cambio de workspace conserva borradores por ID, cierra recursos del runtime anterior y revierte completamente si el candidato no puede activarse.
- Monaco vuelve a reconocer `FILE_CONFLICT` por código estable y mantiene intacto el borrador cuando el archivo cambia en disco.
- El catálogo global ya no modifica permisos de directorios padre preexistentes; solo crea directorios privados y mantiene su base SQLite en `0600`.
- Los avisos de borradores y conflictos de lock reciben foco explícito, permanecen dentro del diálogo modal y restauran el foco al cerrarse.
- Una herramienta recién desanclada se reencuadra automáticamente y ya no puede quedar fuera del viewport del canvas.
- Las URI y mensajes LSP se median, limitan y redactan antes de cruzar el WebSocket autenticado; las respuestas de una sesión anterior se descartan.
- Las rutas API codificadas, las sesiones REST/LSP ausentes u obsoletas y los métodos LSP con efectos ya no pueden eludir las fronteras de autenticación o workspace.
- La inicialización LSP fuerza la raíz activa, usa el runtime TypeScript incluido y acota tanto la entrada stdio como la salida pendiente del navegador.
- El modo global de solo lectura se conserva en cada hot-swap y vuelve a bloquear escrituras en el nuevo workspace.
- La activación devuelve sesión y bootstrap de forma atómica; otras pestañas ponen sus operaciones en cuarentena hasta hidratar el nuevo workspace.
- La paginación de carpetas consume cursores opacos autenticados, invalida listados mutados y permite cargar más de 100 directorios sin omisiones silenciosas.
- Una respuesta de bootstrap o apertura atrasada ya no puede sustituir una transición más reciente; la hidratación de UI y la confirmación del transporte quedan acopladas.
- Los eventos de la nueva sesión recibidos durante la cuarentena fuerzan una reconciliación autoritativa al confirmar el cambio, sin perder deltas tempranos.
- La confirmación de un cambio con borradores queda ligada a la sesión de origen y revalida tareas Act, transición y guardado antes de descartar estado.
- El onboarding explícito ya no reaparece durante una reconciliación transitoria ni intercepta interacciones del canvas.
- Los fallos de limpieza posteriores a una activación confirmada se auditan sin revertir al runtime anterior, y todas las rutas de estado se mantienen fuera de cada repositorio.

### Known issues

- Los servidores de lenguaje incluidos cubren únicamente TypeScript, JavaScript y Python y se ejecutan como procesos locales del mismo usuario.
- La generación depende de que el proveedor remoto tenga credenciales, cuota y red, o de que el daemon local y el modelo configurado estén disponibles.
- Vite continúa advirtiendo sobre chunks grandes de Monaco y ELK.
- Permanece una carrera TOCTOU residual frente a otro proceso hostil ejecutado con la misma cuenta de macOS.
- Mover una herramienta entre dock y canvas recrea su vista; el borrador y la PTY sobreviven, pero cierto estado visual puede reiniciarse.
- El soporte sigue limitado a macOS y el índice semántico conserva sus límites de seguridad predeterminados.

## [v0.0.4] - 2026-07-21

### Added

- Docking opcional y persistente: Editor y Asistente pueden anclarse a la derecha, Terminal abajo y todos conservan el modo flotante.
- Separación visual entre el canvas semántico transformable y las herramientas ancladas al viewport.
- Settings local para `LLM_BASE_URL`, `LLM_MODEL` y la clave write-only `LLM_API_KEY`, con valores predeterminados `https://api.openai.com/v1` y `gpt-4o`.
- Compatibilidad con endpoints OpenAI-compatible en loopback, incluido Ollama en `http://localhost:11434/v1`, sin exigir una clave.
- Almacenamiento privado y transaccional del secreto en el agente, ligado al endpoint y sin inyectarlo en navegador, SQLite, logs o entornos de procesos hijo.
- Menú contextual accesible de nodos con acciones explícitas para inspeccionar, explorar relaciones, abrir archivos o crear terminales.

### Fixed

- WebSocket autentica el token de capacidad durante el handshake y valida conjuntamente `Origin` y `Host`, sin aceptar conexiones anónimas transitorias.
- Ask completa el mismo turno mediante Ask Local ante cuota insuficiente, clave inválida, rate limit o fallo de red, preservando el historial y mostrando una guía útil.
- Los timeouts del proveedor se distinguen de una cancelación manual, descartan texto parcial y completan el turno mediante Ask Local.
- Pan, zoom y relayout del grafo ya no desplazan los paneles anclados ni mezclan sus dimensiones con el layout semántico.
- La pestaña activa de cada dock se conserva al recargar y las pestañas inactivas permanecen montadas para preservar Monaco y xterm.
- El clic derecho sobre un nodo ya no crea una terminal de manera inmediata e inesperada.
- El cierre del indexador ya no puede bloquearse esperando un worker de Tree-sitter; su apagado cooperativo tiene un fallback acotado.
- Settings impide guardar valores predeterminados si la configuración inicial sigue cargando o falló, y permite reintentar sin perder campos editados.
- La selección realizada desde el menú contextual ahora se refleja también en el estado visual controlado de React Flow.

### Known issues

- La generación depende de que el proveedor remoto tenga credenciales, cuota y red, o de que el daemon local y el modelo configurado estén disponibles y sean compatibles.
- Vite continúa advirtiendo sobre chunks grandes de Monaco y ELK.
- Permanece una carrera TOCTOU residual frente a otro proceso hostil ejecutado con la misma cuenta de macOS.
- Un proceso hostil ejecutado como el mismo usuario podría leer el archivo privado de credencial; Act solo debe usarse con repositorios confiables.
- Mover una herramienta entre dock y canvas recrea su vista; borradores y PTY sobreviven, pero cierto estado visual puede reiniciarse.
- El soporte sigue limitado a macOS y el índice semántico conserva sus límites de seguridad predeterminados.

## [v0.0.3] - 2026-07-17

### Added
- Apertura canónica de proyectos externos con ID estable, Modo Lectura/Edición, lock exclusivo y estado fuera del repositorio.
- Onboarding con detección de proyecto/lenguajes, progreso, límites y omisiones; estados visibles de Ask, Codex y acceso.
- Ask Local offline con resultados estructurados, snippets filtrados y fallback en el mismo turno cuando OpenAI no tiene cuota.
- Filtros de canvas por tipo/extensión, preservación de evidencia y layout con resolución determinista de colisiones.
- Fixtures externos, pruebas de aislamiento A/B, sandbox PTY de solo lectura y escenarios Playwright dedicados.

### Fixed
- Fugas de rutas absolutas mediante tareas Act y alias equivalentes de macOS como `/var` y `/private/var`.
- Revalidación de la identidad canónica antes de escanear, indexar, consultar snippets, iniciar PTY o aprobar/ejecutar Codex.
- Cruces potenciales de conversaciones, layouts, terminales y aprobaciones entre workspaces.
- Onboarding desactualizado durante el escaneo al ignorar resúmenes recibidos por `index.progress`.
- Estado de Ask desactualizado en la Topbar después de errores de cuota, clave o red.
- Contrato de bootstrap incompleto: ahora expone y valida conjuntamente `mode` y `readOnly`.
- El presupuesto agregado predeterminado del escáner ahora coincide con el límite documentado de 2 MiB.
- El CLI ya no imprime la URL que contiene el token efímero de capacidad.

### Known issues
- Ask OpenAI depende de una clave y cuota válidas; Ask Local mantiene el workspace operativo cuando no están disponibles.
- Vite continúa advirtiendo sobre chunks grandes de Monaco y ELK.
- Permanece una carrera TOCTOU residual frente a otro proceso hostil ejecutado con la misma cuenta de macOS.

## [v0.0.2] - 2026-07-16

### Added
- Escaneo progresivo acotado, truncamiento durable del grafo y paginación recuperable para proyectos de hasta 10.000 archivos elegibles.
- Orquestador de desarrollo, smoke del CLI empaquetado, benchmark de runtime y smoke real opt-in para Codex CLI 0.144.5.
- Pruebas de reconexión, capacidades, evidencia bidireccional, recuperación de tareas Act y persistencia de terminales.

### Fixed
- Carreras de bootstrap que podían sobrescribir desconexiones, capacidades o páginas del grafo más recientes.
- Restauración de sesiones PTY, conflictos de guardado de Monaco y persistencia monotónica del layout.
- Timeouts ambiguos de Codex que podían dejar un turno ejecutándose mientras se aprobaba una segunda tarea.
- Límites agregados de memoria, rescaneo de índices truncados y propagación transaccional del estado de truncamiento.
- Correlación y recuperación de Ask/Act, rutas de evidencia verificadas y validación estricta del protocolo local.

### Known issues
- La prueba real de «Preguntar» sigue bloqueada por cuota insuficiente del proyecto de OpenAI configurado.
- Vite advierte sobre chunks grandes generados por Monaco y ELK; no se observaron fallos funcionales.
- Permanece una carrera TOCTOU residual frente a otro proceso hostil ejecutado por el mismo usuario de macOS.

## [v0.0.1] - 2026-07-16

### Added
- Bucle de herramientas de solo lectura para «Preguntar», con streaming, presupuestos, cancelación y rutas de evidencia validadas.
- Adaptador de Codex App Server `0.144.1` con aprobación por turno, auditoría, cancelación y denegación de ampliaciones de permisos.
- Persistencia y recuperación de borradores de editor, transcripciones PTY, vistas parciales del grafo y estado del workspace.
- Pruebas de seguridad, recuperación del watcher, reconexión, conflictos de edición, runtime empaquetado y benchmark de 10.000 archivos.
- Verificación automatizada de coherencia de versiones para paquetes, documentación, cliente Codex y etiquetas Git.

### Fixed
- Recuperación del watcher antes y después de `ready`, reconciliación incremental y revisiones transaccionales del índice.
- Sincronización de deltas del grafo, límites visuales, expansión progresiva y preservación del estado tras reconectar.
- Escrituras atómicas, detección de conflictos externos y recuperación explícita de borradores en Monaco.
- Pérdida de salida al terminar una PTY, restauración de transcripciones y orden de paneles dentro del canvas.
- Manejo de solicitudes vacías, autenticación local, redacción de secretos y validación de mensajes REST/WebSocket.
- Ciclo RPC de Codex, eventos terminales, fallos del proceso y solicitudes server-to-client no autorizadas.

### Known issues
- La prueba real de «Preguntar» sigue bloqueada por cuota insuficiente del proyecto de OpenAI configurado.
- Vite advierte sobre chunks grandes generados por Monaco y ELK; no se observaron fallos funcionales.

## [v0.0.0] - 2026-07-16

### Added
- Estado inicial del MVP de Constelix.
- Agente local, grafo incremental JS/TS/Python, canvas visual, editor Monaco y terminales PTY.
- Modos de IA «Preguntar» y «Actuar», persistencia local, seguridad de rutas y auditoría.
- Pruebas unitarias, integración, E2E conectado, benchmark y empaquetado CLI.

### Fixed
- Carrera de inicialización del watcher que podía perder el primer cambio realizado durante el crawl inicial de proyectos grandes.
- Carrera de conexión de terminales que podía perder la salida inicial de la PTY antes de que el panel comenzara a escucharla.
- Ciclo de vida E2E que podía dejar un proceso Vite huérfano y bloquear ejecuciones posteriores en el puerto 5173.

### Known issues
- La prueba real de «Preguntar» está bloqueada en el entorno actual por cuota insuficiente de OpenAI.
- La verificación local se ejecutó con Node.js 22; Constelix exige Node.js 24 y la CI está configurada para esa versión.
- Vite advierte sobre chunks grandes generados por Monaco y ELK; no provoca fallos funcionales, pero requiere optimización posterior.
- El watcher todavía no reconstruye automáticamente sus suscripciones si el backend falla después de haber alcanzado el estado `ready`.
