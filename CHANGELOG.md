# Changelog

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
