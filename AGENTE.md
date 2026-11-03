# Instrucciones del proyecto

Arnés de código en consola (TypeScript, Node >= 20, ESM). Se usa a sí mismo como instrucciones cuando se ejecuta sobre este repositorio.

## Comandos

- `npm run lint`: Biome (lint y formato). `npm run format` aplica las correcciones.
- `npm run typecheck`: `tsc --noEmit`.
- `npm test`: vitest.
- Antes de dar un cambio por terminado deben pasar los tres.

## Reglas

- Idioma: español en interfaz, prompts, mensajes de commit y documentación.
- Commits convencionales, sin `Co-Authored-By` ni otros trailers de atribución.
- Una funcionalidad por commit, con sus tests y documentación.
- Sin `any` explícito. Imports con extensión `.js` (ESM).
- Toda herramienta que escribe, borra o ejecuta pasa por `src/tools/guarded.ts` y `src/permissions.ts`; no saltarse esa capa.
- Los secretos solo por variables de entorno (`${VARIABLE}` en la configuración). Nunca en archivos versionados.
- Los tests no deben depender del sistema operativo: usar `node:path` en lugar de rutas escritas a mano.

## Estructura

- `src/agent/`: turno del modelo, reintentos, compactación de contexto.
- `src/workflow/`: plan, rama, verificación, revisión, commit, push, PR y tracker.
- `src/tools/`: herramientas con seguridad. `src/mcp/`: clientes MCP.
- `src/ui/`: presentación de la sesión (colores, cuadros, selector con teclado, diálogos de permiso). `src/chat.ts`: sesión interactiva; `src/turn.ts`: un turno del modelo con salida visual.
- `test/`: un archivo por área; el modelo y el tracker se simulan, sin red.
