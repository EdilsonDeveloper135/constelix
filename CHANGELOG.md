# Changelog

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
