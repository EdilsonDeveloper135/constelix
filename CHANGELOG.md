# Changelog

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
