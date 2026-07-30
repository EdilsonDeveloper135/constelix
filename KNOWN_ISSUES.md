# Errores y limitaciones conocidas

Actualizado para `v0.0.5` el 2026-07-29.

## KI-001 — Disponibilidad y compatibilidad del proveedor LLM

- Estado: abierto, dependencia externa/local; mitigado funcionalmente.
- Impacto: un proveedor remoto puede rechazar credenciales, agotar cuota, limitar
  solicitudes o perder conectividad. Un proveedor local puede no estar iniciado,
  no tener el modelo instalado o implementar de forma incompleta el protocolo
  OpenAI-compatible requerido por streaming y herramientas.
- Mitigación: Ask Local completa el mismo turno para cuota, clave inválida, rate
  limit y red sin perder el historial. La UI conserva un aviso accionable; para
  Ollama solicita verificar el daemon, el puerto y el modelo configurado.

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
- Impacto: v0.0.5 soporta únicamente macOS; la terminal segura de Modo Lectura
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

## KI-007 — Secreto LLM frente a procesos del mismo usuario

- Estado: riesgo local aceptado y documentado.
- Impacto: la credencial introducida en Settings reside fuera del repositorio en
  un archivo `0600`, pero un proceso hostil que ya se ejecute como el mismo usuario
  de macOS —incluido un turno Act aprobado— podría intentar leerlo.
- Mitigación: la clave nunca se inyecta en navegador, SQLite, logs, prompts ni
  entornos hijo; se liga al endpoint y se elimina al cambiar de proveedor. Usar
  Act solo con repositorios confiables y borrar claves no necesarias. Keychain o
  un sandbox de lectura más estricto quedan para una versión posterior.

## KI-008 — Estado visual al mover herramientas entre dock y canvas

- Estado: limitación de interfaz aceptada.
- Impacto: cambiar una herramienta entre el dock y el canvas recrea la vista de
  Monaco o xterm. El borrador y el proceso PTY continúan, y se recuperan hasta
  256 KiB de salida, pero el historial de deshacer, cursor o scroll visual puede
  reiniciarse. Cambiar entre pestañas dentro del mismo dock no desmonta la vista.
- Mitigación: persistir borradores y sesiones por ID; una futura capa de portales
  conservará también el estado visual completo entre hosts.

## KI-009 — Alcance y confianza de los servidores de lenguaje

- Estado: limitación técnica y de seguridad aceptada.
- Impacto: v0.0.5 ofrece LSP únicamente para TypeScript, JavaScript y Python.
  `typescript-language-server` y Pyright se ejecutan como procesos del usuario
  local y analizan configuración y dependencias del workspace; no constituyen
  una frontera frente a un repositorio hostil.
- Mitigación: usar LSP solo con repositorios confiables. El agente fija las
  implementaciones, fuerza la raíz, restringe métodos, sanea su entorno, media
  URI, impone límites de mensajes y contrapresión, autentica el WebSocket y
  termina cada proceso al cerrar o cambiar workspace.

## KI-010 — Identidad de workspaces movidos y procesos durante el hot-swap

- Estado: limitación de lifecycle aceptada.
- Impacto: mover un repositorio cambia su identidad y deja la entrada reciente
  anterior como no disponible. Un cambio de workspace termina las PTY y los
  procesos LSP/Codex del runtime anterior; no se reanudan al regresar.
- Mitigación: el selector informa disponibilidad, conserva borradores locales
  por workspace y exige una decisión antes de cambiar con ediciones pendientes.
  Las sesiones de procesos reanudables permanecen fuera de este checkpoint.

## Estado de pruebas

La verificación de `v0.0.5` se ejecutó con Node.js 24.18.0 y pnpm 11.7.0:

- instalación congelada, `git diff --check`, version check, typecheck, build,
  smoke LSP y creación del tarball: correctos;
- Vitest: 41 archivos y 296 pruebas correctas, incluidas las integraciones de
  SQLite, locks, lifecycle A→B, aislamiento de sesión y transporte LSP;
- Playwright: 17 de 17 escenarios correctos en Chromium, incluidos hot-swap,
  recientes, paginación de carpetas, navegación, foco, borradores, locks,
  Monaco y PTY;
- benchmark de 10.000 archivos y 2.000.000 de líneas: indexación fría en
  44.059 ms, actualización incremental p95 en 156 ms y PTY p95 en 0 ms, dentro
  de los presupuestos de 90 s, 1 s y 100 ms;
- smoke LSP: diagnósticos y hover reales correctos con los servidores
  TypeScript y Pyright incluidos;
- smoke del paquete: tarball `constelix-agent-0.0.5.tgz` instalado en un entorno
  temporal, ruta con espacios y dashboard servido correctamente;
- QA renderizada: cambio A→B→A, selector, retorno de foco y LSP TypeScript/Python
  verificados sin errores ni advertencias de consola.

Los smokes reales de proveedores LLM y Codex siguen siendo opt-in porque
requieren servicios externos, credenciales o un turno con efectos. Sus
protocolos, fallbacks, sandbox y redacción se validan con dobles automatizados.
Este checkpoint conserva las limitaciones KI-001, KI-003 a KI-010 y no se
declara libre de riesgos conocidos.
