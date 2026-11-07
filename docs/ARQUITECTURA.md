# Arquitectura de agente

`agente` es un arnés de código para consola: un modelo de lenguaje con herramientas (leer/editar archivos, comandos, MCP) dentro de un flujo controlado **issue → plan → rama → implementación → verificación → revisión → commit → push → PR → tracker**.

## Patrón principal

Arquitectura **en capas con inyección de dependencias**, sobre un **bucle de agente** (modelo → herramientas → modelo) y un **pipeline lineal** para el flujo de trabajo.

```
cli.ts  (raíz de composición: cablea todo)
 ├─ chat.ts ........... sesión interactiva, comandos /, memoria, guardado
 ├─ workflow/ ......... flujo work/ship (etapas inyectadas: StageRunner, WorkflowIO, PrCreator)
 │    issue · prompts · run · verify · ship · pr · summary · runs
 ├─ agent/ ............ bucle del agente
 │    loop (pasos, reintentos, tiempo) · retry · compaction · system · subagent
 ├─ tools/ ............ herramientas y su capa de seguridad (guarded)
 ├─ mcp/ · connect/ ... clientes MCP (Jira/Trello/GitHub) y asistente /connect
 ├─ ui/ ............... render, diálogos, selección, colores, interrupción (Esc)
 └─ session*, memory, redact, config, models, providers, credentials, git
```

La lógica no depende de la consola: `chat.ts` y `workflow/` reciben `ui`, `io`, `perms` y los ejecutores por parámetro. Por eso las pruebas sustituyen el modelo y la terminal sin tocar red.

## Piezas clave

| Pieza | Qué hace | Dónde |
|---|---|---|
| Multi-modelo | Ids `proveedor/modelo` (Gemini por defecto, Anthropic, OpenAI, Ollama) vía Vercel AI SDK; roles `plan`/`implement`/`light` | `providers.ts`, `models.ts` |
| Bucle del agente | Pasos con tope, reintentos con espera ante cuota/errores temporales, parciales conservados | `agent/loop.ts`, `agent/retry.ts` |
| Seguridad | Rutas limitadas al proyecto, confirmaciones con vista previa, lista blanca de comandos, modos `ask/edits/plan`, secretos redactados | `permissions.ts`, `tools/guarded.ts`, `redact.ts` |
| MCP | Jira/Trello/GitHub como herramientas `mcp__servidor__tool`; `${VAR}` en la configuración; credenciales en `~/.agente/credentials` (600) | `mcp/`, `connect/` |
| Memoria de sesión | Conversación en JSON en `.git/agente/sessions` (escritura atómica, redactada); retomar, buscar, renombrar, exportar | `session.ts`, `session-tools.ts` |
| Compactación | Poda resultados viejos de herramientas y, al 75 % de la ventana, resume con el modelo; archiva el original | `agent/compaction.ts`, `session-archive.ts` |
| Memoria de proyecto/usuario | `/remember` guarda notas (AGENTE.md del proyecto o `~/.agente/memory.md`); solo las escribe el usuario | `memory.ts`, `agent/system.ts` |
| Memoria de flujo | Cada `work`/`ship` deja un resumen en la conversación (sin cuerpo de la issue) | `workflow/summary.ts` |
| Subagentes | Herramienta `delegate`: exploración de solo lectura con contexto propio, de una en una, resultado como datos | `agent/subagent.ts` |
| Flujo | Etapas con aprobación humana del plan y de los cambios; verificación automática con reintento de arreglo | `workflow/` |
| Contenido no confiable | Issues, web y resultados MCP se tratan como datos, no órdenes | `agent/system.ts` |

## Decisiones y por qué

- **JSON y no SQLite:** una sesión es un documento que se lee y escribe entera; no hay consultas relacionales. JSON es legible, se versiona en `.git/` sin dependencias y funciona igual en Windows. (`node:sqlite` queda como evolución si hay muchas sesiones.)
- **No reinventar herramientas:** archivos, grep y bash vienen de `@openharness/core`; el proyecto solo añade la capa `guarded`. La compactación es propia porque la de la librería usa su copia del SDK v6.
- **Humano en el bucle:** plan, cambios y push piden confirmación; `--yes` solo para pruebas y demos.
- **Subagentes de solo lectura y en serie:** reducen el contexto principal sin riesgo de escrituras concurrentes ni gasto de cuota en paralelo.
- **Sin coautores:** los commits llevan solo al autor del git del usuario; el arnés elimina trailers de atribución del mensaje generado.

## Calidad

CI en Ubuntu y Windows: lint (Biome), typecheck, tests (vitest), build y `npm run smoke` (flujo completo contra un modelo simulado, repositorio temporal y remoto bare). `npm run demo` muestra un subagente sin red ni claves.
