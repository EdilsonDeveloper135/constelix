# ADR 0001 — Shell progresivo con una herramienta primaria

- Estado: aceptado
- Fecha: 2026-08-02
- Versión: v0.0.8

## Contexto

Constelix combina un mapa semántico, Monaco, múltiples PTY y un asistente con
modos Preguntar/Actuar. Mostrar todas esas superficies simultáneamente hacía que
el layout, la persistencia y la navegación compitieran entre sí, especialmente
en pantallas compactas. El estado transitorio de modales y apariencia también
estaba demasiado cerca del estado durable del workspace.

## Decisión

El shell expone una herramienta primaria por vez:

1. Mapa para orientación y relaciones;
2. Código para lectura/edición verificada;
3. Terminal para una o varias sesiones PTY;
4. Preguntar para búsqueda, generación y Actuar aprobado.

La herramienta activa controla visibilidad, no ciclo de vida. Los borradores,
sesiones PTY, conversaciones y layouts continúan en su store de dominio. Tema,
escala, ayuda, configuración y paleta pertenecen a un store del shell separado.
En viewports compactos la misma navegación se presenta como barra inferior y la
superficie activa ocupa el espacio disponible.

Las reglas de creación/visibilidad de paneles deben residir en
`workspaceState.ts`; los estilos de producto y responsive deben mantenerse en
sus hojas dedicadas. Nuevas capacidades globales se anuncian en Topbar o
Settings, no como una herramienta primaria adicional sin recorrido definido.

## Consecuencias

### Positivas

- menor carga visual y una secuencia de uso explicable;
- responsive basado en prioridad, no en compresión;
- cambios de herramienta sin perder PTY ni borradores;
- pruebas E2E pueden expresar recorridos reales y accesibles;
- rehidratación del workspace no abre modales ni altera preferencias del shell.

### Costes

- comparar dos herramientas requiere alternar entre ellas;
- un dock/floating host puede recrear la vista y conservar solo el estado de
  dominio, no todo el estado visual interno de Monaco/xterm;
- cada nueva herramienta debe definir su lugar en el flujo y sus reglas de
  persistencia antes de incorporarse a la navegación.

## Reglas de validación

- solo una categoría de herramienta debe estar visible en móvil;
- todas las terminales de la categoría Terminal pueden coexistir;
- cambiar de herramienta no crea ni elimina procesos implícitamente;
- modales restauran foco y no se serializan con el layout del workspace;
- no debe aparecer overflow horizontal a 390 × 844;
- desktop, light/dark y modo lectura se cubren antes de un checkpoint.
