# Versionado de Constelix

Esta convención es obligatoria para todos los checkpoints, commits de versión y etiquetas de Constelix.

## 1. Formato

Las versiones usan el formato `vMAJOR.MINOR.PATCH`:

- `MAJOR`, `MINOR` y `PATCH` son enteros no negativos.
- La etiqueta Git y el prefijo del commit incluyen `v`.
- Los campos `version` de los paquetes npm usan la misma versión sin `v`.
- Durante el desarrollo inicial, `MAJOR` permanece en `0`.

## 2. Incrementos

- `PATCH`: correcciones de errores, documentación o cambios pequeños compatibles.
- `MINOR`: funcionalidad nueva compatible con la versión anterior.
- `MAJOR`: cambios importantes o incompatibles. Antes de `v1.0.0`, estos cambios se expresan con un incremento de `MINOR` y se documentan explícitamente.

## 3. Formato obligatorio de commits

Todo commit de checkpoint debe usar:

```text
vMAJOR.MINOR.PATCH - tipo: Resumen breve
```

Tipos habituales: `chore`, `fix`, `feat`, `docs`, `refactor`, `test`, `perf` y `build`.

Ejemplo:

```text
v0.0.1 - fix: Correct workspace startup errors
```

## 4. Procedimiento de commit y etiqueta

1. Ejecutar `git status` y revisar todos los cambios.
2. Consultar `git tag --list --sort=version:refname` y seleccionar la siguiente versión SemVer disponible.
3. No reutilizar una versión presente en `VERSION`, el changelog, el historial Git o las etiquetas.
4. Ejecutar typecheck, pruebas, build, E2E y los benchmarks aplicables.
5. Actualizar `KNOWN_ISSUES.md` con problemas reales y resultados pendientes.
6. Auditar que no se incluyan `.env`, claves, tokens, credenciales, dependencias, temporales o artefactos innecesarios.
7. Actualizar `VERSION`, las versiones npm, este documento y `CHANGELOG.md`.
8. Ejecutar `pnpm version:check` para comprobar que todos los metadatos coinciden.
9. Preparar únicamente los archivos revisados y comprobarlos con `git diff --cached`.
10. Crear el commit con el formato obligatorio.
11. Crear una etiqueta anotada con la misma versión:

```bash
git tag -a vMAJOR.MINOR.PATCH -m "Constelix vMAJOR.MINOR.PATCH"
```

12. Verificar el commit, la etiqueta y el estado final. Nunca hacer push sin autorización expresa.

## 5. Versión actual

`v0.0.5`

## 6. Historial

| Versión | Fecha | Descripción |
|---|---|---|
| `v0.0.5` | 2026-07-29 | LSP local para TypeScript/JavaScript/Python, cambio dinámico de workspace y leases recuperables. |
| `v0.0.4` | 2026-07-21 | Paneles anclables, configuración LLM local, handshake WebSocket autenticado y fallback ampliado. |
| `v0.0.3` | 2026-07-17 | Proyectos externos seguros, Ask Local offline, onboarding y aislamiento por workspace. |
| `v0.0.2` | 2026-07-16 | Cierre del hardening del MVP, recuperación de sesiones y validación completa del release. |
| `v0.0.1` | 2026-07-16 | Hardening del runtime, sincronización incremental y flujos IA del MVP. |
| `v0.0.0` | 2026-07-16 | Checkpoint inicial del MVP de Constelix. |

## 7. Inmutabilidad

Una versión publicada en un commit o etiqueta no se modifica, mueve ni reutiliza. Cualquier cambio posterior recibe una versión única superior.
