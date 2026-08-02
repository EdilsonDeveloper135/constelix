# Auditoría integral de producto, arquitectura, UX y UI — v0.0.8

Fecha: 2026-08-02
Alcance: dashboard web, agente local, contratos compartidos, arranque de
desarrollo y recorridos demo/conectado.
Resultado: los problemas funcionales y de experiencia incluidos en esta
auditoría quedan corregidos y cubiertos por pruebas. Las restricciones externas
y riesgos aceptados permanecen declarados en `KNOWN_ISSUES.md`.

## Criterio de cierre

Un hallazgo se considera cerrado cuando tiene:

1. una solución implementada en la frontera correcta;
2. comportamiento observable y comprensible para la persona usuaria;
3. validación automatizada o inspección visual reproducible;
4. ausencia de una regresión equivalente en los recorridos conectados.

## 1. Product Purpose

### P-01 — La propuesta de valor no guiaba la primera decisión

- Problema: el producto mostraba muchas capacidades técnicas a la vez, pero no
  explicaba qué resultado obtiene la persona ni por dónde empezar.
- Solución: el propósito se expresa como un flujo progresivo: **Mapa → Código →
  Preguntar → Actuar**. El onboarding ahora abre con “Explora el código.
  Entiende relaciones. Actúa con contexto.” y permite omitir o iniciar un
  recorrido.
- Evidencia: `WorkspaceOnboarding`, `Rail`, `HelpCenter` y los E2E del workspace.
- Estado: resuelto.

### P-02 — Demo, workspace real y capacidades parecían equivalentes

- Problema: los estados de conexión, proveedor y permisos podían inducir a
  pensar que una capacidad estaba operativa cuando solo era demostrativa o
  local.
- Solución: la Topbar distingue Modo demostración/Agente local, Edición/Lectura,
  Búsqueda local/LLM conectado y Actuar disponible/bloqueado.
- Evidencia: `workspacePresentation`, `Topbar` y escenarios E2E de demo, modo
  conectado y modo lectura.
- Estado: resuelto.

### P-03 — Preguntar y Actuar no comunicaban suficientemente su diferencia

- Problema: una búsqueda local, una generación remota y una acción con efectos
  compartían demasiado contexto visual.
- Solución: Preguntar muestra el modo efectivo y evidencia verificable; Actuar
  exige preparar, revisar y aprobar un turno por separado, con advertencias de
  confianza y bloqueo explícito en solo lectura.
- Evidencia: `AssistantPanel`, contratos Ask/Codex y E2E de evidencia,
  aprobación y fronteras read-only.
- Estado: resuelto.

### P-04 — La ayuda no estaba disponible en el momento de necesidad

- Problema: el onboarding era la única explicación relevante y podía quedar
  atrás después del primer uso.
- Solución: centro de ayuda reabrible desde la navegación, con los cuatro pasos,
  accesos directos a cada herramienta, estado actual y configuración.
- Evidencia: `HelpCenter` y prueba de foco/Escape.
- Estado: resuelto.

## 2. Arquitectura de software

### A-01 — Estado persistente y estado transitorio del shell estaban acoplados

- Problema: modales, tema y navegación competían con grafo, borradores, paneles
  y sesiones en el store principal, aumentando el riesgo de rehidrataciones no
  deseadas.
- Solución: `useShellStore` conserva solo preferencias y estado transitorio;
  `useWorkspaceStore` mantiene el dominio del workspace. `useAppearance`
  traduce preferencias a atributos del documento.
- Evidencia: pruebas unitarias del shell y E2E de apariencia.
- Estado: resuelto.

### A-02 — Reglas de layout y visibilidad estaban duplicadas en un hotspot

- Problema: crear, mostrar, ocultar y rehidratar herramientas estaba mezclado
  con acciones del store, dificultando razonar sobre terminales múltiples y la
  herramienta activa.
- Solución: `workspaceState.ts` centraliza nodos iniciales, layout, visibilidad y
  grafo derivado. Las transiciones conservan todos los paneles terminales cuando
  Terminal es la herramienta activa y ocultan las demás superficies.
- Evidencia: unit tests del store y E2E de ciclo de vida Monaco/xterm.
- Estado: resuelto.

### A-03 — El servidor concentraba responsabilidades no relacionadas

- Problema: el mapeo de errores HTTP y nuevas integraciones de sistema/proveedor
  seguían ampliando el archivo principal del agente.
- Solución: `server-errors.ts`, `llm-connection.ts` y
  `native-folder-picker.ts` encapsulan errores, prueba del proveedor y selección
  nativa. Los contratos Zod validan solicitudes y respuestas en la frontera.
- Evidencia: pruebas unitarias específicas y typecheck estricto.
- Estado: resuelto.

### A-04 — Los estilos de producto y responsive no tenían una frontera clara

- Problema: iterar la experiencia añadía excepciones a una hoja heredada grande,
  con alto riesgo de colisiones.
- Solución: `styles/product.css` define jerarquía, temas y componentes nuevos;
  `styles/responsive.css` concentra los breakpoints y la navegación compacta.
- Evidencia: build, E2E a 390 × 844 e inspección visual en desktop/móvil.
- Estado: resuelto.

### A-05 — El arranque fallaba tarde y la sintaxis documentada era frágil

- Problema: `pnpm dev -- /ruta` podía interpretar `--` como ruta, y usar una
  versión antigua de Node terminaba en fallos de ABI difíciles de diagnosticar.
- Solución: parser explícito para ambas formas de invocación, rechazo de
  argumentos ambiguos y guardia temprana de Node 24 en instalación.
- Evidencia: `run-dev.test.ts`, `check-runtime.mjs` y build con Node 24.
- Estado: resuelto.

## 3. UX (User Experience)

### X-01 — Demasiados paneles simultáneos competían por atención

- Problema: grafo, editor, terminal y asistente podían dominar el mismo viewport
  y ocultar la tarea principal.
- Solución: una herramienta primaria por vez, accesible desde una navegación
  estable; las sesiones y borradores sobreviven al cambio de herramienta.
- Evidencia: E2E de navegación, múltiples terminales y conflicto de archivo.
- Estado: resuelto.

### X-02 — La navegación duplicaba acciones y anunciaba opciones no funcionales

- Problema: controles equivalentes aparecían en varias zonas y algunas acciones
  sin implementación parecían disponibles.
- Solución: Rail reducido a Mapa, Código, Terminal, Preguntar y Ayuda;
  configuración queda como acción global y la Topbar concentra estado/comandos.
- Evidencia: inspección visual y navegación por roles accesibles.
- Estado: resuelto.

### X-03 — Abrir un proyecto exigía conocer y escribir una ruta

- Problema: la ruta absoluta era una barrera, especialmente para usuarios menos
  técnicos.
- Solución: recientes, explorador paginado precargado, entrada manual y selector
  nativo “Elegir carpeta…”, con cancelación segura y fallback.
- Evidencia: pruebas del picker y E2E de selector, foco, paginación y hot-swap.
- Estado: resuelto.

### X-04 — Configurar IA era ensayo y error

- Problema: la persona debía guardar una Base URL/modelo/clave sin saber si la
  combinación funcionaba.
- Solución: presets, requisitos de clave según endpoint, prueba de conexión con
  timeout, mensajes accionables y secreto write-only.
- Evidencia: pruebas de conexión y E2E de hidratación, fallo, retry, guardado y
  borrado de credencial.
- Estado: resuelto.

### X-05 — La paleta no cumplía la expectativa de búsqueda global

- Problema: parecía un buscador, pero se limitaba a comandos estáticos.
- Solución: resultados reales de archivos y símbolos, grupos claros, selección
  con flechas/Home/End y apertura directa del resultado.
- Evidencia: E2E de teclado y búsqueda conectada/local.
- Estado: resuelto.

### X-06 — Foco, salida y restauración eran inconsistentes en overlays

- Problema: modales, menús y pestañas podían dejar el foco fuera del contexto o
  requerir ratón.
- Solución: foco inicial, ciclo Tab/Shift+Tab, flechas, Home/End, Escape y
  restauración al disparador en paleta, ayuda, selector y menú contextual.
- Evidencia: E2E accesibles dedicados.
- Estado: resuelto.

### X-07 — El grafo podía perder el encuadre por evidencia histórica o móvil

- Problema: respuestas terminadas reencuadraban el canvas y el zoom inicial no
  mostraba el mapa completo en pantallas estrechas.
- Solución: solo la evidencia en progreso toma foco; historial completado
  conserva el overview y el viewport compacto calcula un zoom inicial seguro.
- Evidencia: inspección de viewport React Flow y E2E de evidencia.
- Estado: resuelto.

### X-08 — Una respuesta tardía podía reemplazar la ruta escrita

- Problema: si la persona empezaba a escribir una ruta mientras el selector
  todavía cargaba recientes o el directorio personal, la respuesta inicial
  podía restaurar la carpeta anterior y hacer que se explorara el destino
  equivocado.
- Solución: las solicitudes de exploración se invalidan por época y la carga
  inicial aplica su ruta solo cuando el borrador no cambió. La entrada de la
  persona siempre prevalece sobre respuestas obsoletas.
- Evidencia: dos pruebas unitarias de concurrencia y el E2E paginado con 105
  carpetas dentro de la suite conectada completa.
- Estado: resuelto.

## 4. UI (User Interface)

### U-01 — Jerarquía, contraste y densidad dificultaban escanear la pantalla

- Problema: encabezados, estado, controles y contenido tenían pesos similares;
  algunos textos eran demasiado pequeños o de contraste bajo.
- Solución: tokens de superficie/estado, tipografía mínima legible, contraste
  revisado, cabeceras compactas y resumen de capacidades con etiquetas
  semánticas.
- Evidencia: QA visual desktop/light/dark y comprobación de tamaños computados.
- Estado: resuelto.

### U-02 — Solo existía una apariencia efectiva

- Problema: la UI dependía del tema oscuro y no respetaba preferencia del
  sistema ni necesidades de lectura.
- Solución: temas oscuro, claro y sistema; escalas de texto persistentes y
  colores coordinados para React Flow, minimapa y fondos.
- Evidencia: test E2E de atributos `data-theme`/`data-text-scale` y QA visual.
- Estado: resuelto.

### U-03 — La experiencia compacta era una reducción del desktop

- Problema: docks y rail lateral comprimían editor, terminal y asistente,
  produciendo superficies estrechas y riesgo de overflow.
- Solución: navegación inferior, panel activo a ancho completo, asistente
  apilado, inspector como hoja inferior y mapa reencuadrado.
- Evidencia: E2E 390 × 844 sin overflow horizontal y captura visual móvil.
- Estado: resuelto.

### U-04 — Controles secundarios generaban ruido permanente

- Problema: leyenda y filtros ocupaban espacio aunque no se utilizaran; la marca
  de React Flow competía con la identidad del producto.
- Solución: filtros/leyenda colapsables, controles de zoom compactos,
  atribución visual retirada conforme a la API y favicon Constelix.
- Evidencia: QA visual y E2E de filtros/encuadre.
- Estado: resuelto.

## Validación de cierre

La entrega se valida con:

- `pnpm version:check`;
- `pnpm typecheck`;
- `pnpm test`;
- `pnpm build`;
- `pnpm test:e2e`;
- `pnpm benchmark`;
- `pnpm smoke:lsp`;
- `pnpm smoke:package`;
- `pnpm audit --prod` y `git diff --check`.

Los resultados medidos del checkpoint se registran en `KNOWN_ISSUES.md`. Los
warnings de desconexión WebSocket que Vite imprime al finalizar un contexto E2E
son cierres esperados del navegador; no corresponden a errores de producto y no
generan fallos de prueba.

## Restricciones no confundidas con defectos de esta auditoría

- plataforma soportada: macOS;
- LSP incluido: JavaScript/TypeScript y Python;
- disponibilidad de un proveedor remoto/local fuera del control del producto;
- presupuestos de indexación deliberadamente acotados;
- imposibilidad de aislar procesos hostiles bajo la misma cuenta del sistema.

Estas restricciones siguen visibles, mitigadas y documentadas; no se ocultan ni
se declaran resueltas artificialmente.
