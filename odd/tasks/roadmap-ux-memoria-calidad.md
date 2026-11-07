# Hoja de ruta: UX, memoria, funcionalidades, calidad, seguridad y entrega

## Objetivo
Llevar el arnés a un estado presentable y sólido: buena interfaz de consola, memoria de sesiones completa, subagentes, seguridad reforzada, calidad medible y una entrega (README, demo, paquete npm) lista para defender.

## Criterio de orden (lo que evita tocar el mismo código dos veces)
1. **Primero la estructura** (sin cambio visible): dividir `cli.ts`, registro de comandos `/`, tipos neutrales, configuración ampliada de una vez, ganchos en el turno. Todo lo que viene después *añade archivos* en lugar de editar los grandes.
2. **Después los datos del motor** (tokens reales, modelos, sesiones, compactación): son la base de los porcentajes, costes, búsqueda y memoria.
3. **Después el motor del turno** (límite de pasos, respaldo de modelos, puntos de control).
4. **Después la capa visual en una sola pasada** (`render.ts`, `dialog.ts`, entrada), ya con los datos disponibles y con soporte de anidación para subagentes.
5. **Después los subagentes**, que usan lo anterior.
6. **Después seguridad**, integraciones reales y Windows; y al final calidad medida, documentación y entrega (el GIF de la demo se graba con la interfaz ya terminada).

## Restricción principal
No cambiar el comportamiento actual por defecto: todo valor nuevo es opcional. Sin configurarlo, el arnés se comporta igual que hoy.

## Reglas de ejecución
- Un commit por tarea, con sus pruebas y su documentación. Sin `Co-Authored-By` ni trailers de atribución.
- Cada tarea de interfaz lleva una prueba de terminal real (R03). Antes de cerrar una tarea: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
- Tamaños: **S** < 2 h · **M** 2-6 h · **L** > 6 h (incluyen pruebas y verificación).
- Push al final de cada fase, cuando el usuario lo apruebe.

## Fase 0 — Cimientos (sin cambio visible)
- [ ] R01 (S) **Tipos neutrales:** mover `DecisionPrompt`, `Reply` y los tipos de permisos a `src/ports.ts`; `ui/` deja de importar de `workflow/`. Archivos: `ui/dialog.ts`, `workflow/run.ts`, `workflow/ship.ts`, `permissions.ts`.
- [ ] R02 (M) **Dividir `cli.ts` y registro de comandos.** `cli.ts` solo parsea argumentos y llama a `main`; `app/context.ts` (construye ui, permisos, MCP), `app/stage-runner.ts`, `app/keys.ts`, y un módulo por comando en `app/commands/` (`work`, `ship`, `issues`, `connect`, `init`, `sessions`). Los comandos `/` pasan a un **registro** (nombre, ayuda, autocompletado, manejador): añadir un comando nuevo es añadir un archivo, no editar `chat.ts`. Aprovechar para cerrar tres pendientes del equipo: `cleanName` duplicado en `mcp/client.ts`, el `catch` silencioso de `session.ts` y la separación `base`/`prBase` en `ship.ts`. Verificación: mismas pruebas, mismo comportamiento.
- [ ] R03 (M) **Pruebas de terminal real dentro del repo:** un arnés `test/e2e/` con pseudo-terminal, modelo falso y tracker falso (los guiones que hoy se hacen a mano), con `npm run test:e2e`. *Decisión:* requiere una dependencia de desarrollo con binarios nativos (p. ej. `node-pty`); necesita aprobación.
- [ ] R04 (S) **Configuración ampliada de una vez:** añadir todas las claves nuevas con valores por defecto neutros (`pricing`, `fallbackModels`, `sandbox`, `subagents`, `theme`, `maxSteps` con modo de continuación, `redact`), más el informe de cobertura de `vitest` (sin umbral todavía). Así `config.ts` no se vuelve a editar. Archivos: `config.ts`, `vitest.config.ts`.

## Fase 1 — Datos del motor: tokens, modelos, sesiones y memoria
- [ ] R05 (M) **Motor v2 (una sola pasada por `loop.ts` y `turn.ts`):** el bucle devuelve `usage` real por paso y turno, `stepsUsed` y `limitReached`; los reintentos se extraen a `agent/retry.ts`; el turno expone **ganchos** (`beforeTurn`, `afterStep`, `onLimit`, `onUsage`) para que las tareas siguientes se registren en lugar de editar el turno.
- [ ] R06 (M) **Registro de modelos `src/models.ts`:** ventana de contexto y precio por modelo conocido (Gemini, Claude, OpenAI), con *override* en la configuración; Ollama pregunta la ventana al servidor. Sustituye el 128.000 fijo.
- [ ] R07 (M) **Compactación v2 (una sola pasada por `compaction.ts`):** se dispara con tokens reales cuando existen; reintento con espera ante errores temporales (reutiliza `retry.ts`); archiva el original antes de resumir (gancho `onCompact`); emite un evento para la interfaz.
- [ ] R08 (L) **Sesiones v2 (una sola pasada por `session.ts`):** formato **JSONL** de solo añadir (migra desde el JSON actual); guarda los **turnos interrumpidos o fallidos** marcados como parciales; carpeta `archive/` con la transcripción original previa a cada compactación; **redacción de secretos** al escribir (claves de API, tokens `ATATT…`, `AIza…`, `sk-…`, `ghp_…`, cabeceras `Bearer`, líneas de `.env`) con pruebas; permisos 600. Tiene en cuenta los 30 por proyecto.
- [ ] R09 (M) **Memoria del flujo:** al terminar o fallar `/work` o `/ship` se añade a la sesión un registro estructurado (issue, plan aprobado, rama, verificación, commit, PR); `start_workflow` se lo devuelve al modelo en lugar de "el flujo terminó". Al retomar, el modelo sabe qué se hizo.
- [ ] R10 (M) **Gestión y búsqueda de sesiones:** `/sessions delete|rename|export` (Markdown), `/search` y `agente sessions --search`. Búsqueda lineal sobre JSONL; `node:sqlite` queda como opción solo si el volumen lo justifica.
- [ ] R11 (M) **Memoria de proyecto y de usuario:** `/remember <texto>` propone añadirlo al `AGENTE.md` (con vista previa y confirmación) o a `~/.agente/memory.md` (preferencias personales); `buildSystemPrompt` pasa a componerse por **secciones** (base, proyecto, usuario, reglas de sesión) para que las tareas siguientes añadan secciones sin editar la lógica.

## Fase 2 — Motor del turno
- [ ] R12 (S) **Límite de pasos:** al llegar a `maxSteps` se avisa y se pregunta si continuar (gancho `onLimit`). Hoy el turno se corta sin decir nada.
- [ ] R13 (M) **Respaldo de modelos ante cuota:** `fallbackModels` en la configuración; al agotarse la cuota diaria o persistir un 429 se cambia al siguiente avisando. Relevante por los límites del nivel gratuito.
- [ ] R14 (M) **Puntos de control y `/undo`:** antes de un turno que puede editar se crea una referencia de git (`refs/agente/checkpoints/...`, sin ensuciar el historial); `/undo` restaura los archivos del último turno con vista previa y confirmación. Funciona también en worktrees. Se engancha en `beforeTurn`; no toca `guarded.ts`.

## Fase 3 — Capa visual (una sola pasada por `render.ts`, `dialog.ts` y la entrada)
- [ ] R15 (L) **Renderizador:** soporte de **profundidad** (actividad anidada para subagentes); Markdown mejor (bloques de código con fondo, tablas, listas numeradas, citas); **diff coloreado** en la revisión de `/work`; línea de **uso y coste** por turno; **barra de progreso** del flujo (`Plan ✔ → Rama ✔ → Implementación ▶ → Revisión → Entrega`); temas (oscuro, claro y mono con `NO_COLOR`/`AGENTE_THEME`).
- [ ] R16 (S) **Barra de estado:** modelo, modo, rama y **% de contexto** junto a la regla; `/status` ampliado. Usa R05 y R06.
- [ ] R17 (M) **Entrada de varias líneas** (`src/ui/input.ts`): Shift+Enter o `\`+Enter, detección de pegado largo y editor externo con `$EDITOR`. Sustituye a `rl.question` en el chat y en el contexto de la issue.
- [ ] R18 (S) **Primera ejecución y ayuda:** tutorial breve de tres pasos, `/help` con ejemplos y un catálogo de errores con "qué hacer ahora".

## Fase 4 — Subagentes
- [ ] R19 (L) **Herramienta `delegar`:** subagente de **solo lectura** (explorar, buscar, resumir) con modelo `light` configurable, contexto aislado, herramientas de lectura, presupuesto de pasos y de tokens, y resultado resumido al padre. Opcionalmente en paralelo (máx. 3). Hereda el modo de permisos y nunca escribe. Muestra su actividad anidada (R15) y registra su uso. Reglas en una sección nueva del prompt (R11).

## Fase 5 — Seguridad
- [ ] R20 (L) **Aislamiento del shell (opcional):** `sandbox: "auto" | "off"`. En Linux con `bwrap` (sin red, escritura solo en el proyecto), en macOS con `sandbox-exec`; en Windows no hay soporte y se avisa. *Decisión:* alcance y riesgo de mantenimiento.
- [ ] R21 (M) **Contenido externo no confiable:** los resultados de `web_fetch`, MCP y archivos se marcan como datos y el prompt incluye una regla contra instrucciones inyectadas; pruebas con cargas de ataque.
- [ ] R22 (S) **Registro de auditoría:** `~/.agente/audit.log` (JSONL) con aprobaciones, denegaciones y comandos, sin contenido sensible; `/audit` muestra las últimas.
- [ ] R23 (S) **Revisión de permisos MCP:** avisar si un servidor expone herramientas de escritura sin `includeTools`; `/mcp` indica cuáles preguntan.

## Fase 6 — Integraciones reales y compatibilidad
- [ ] R24 (M) **Jira real con el servidor de npm:** guion de verificación con credenciales por entorno y correcciones. *Necesita token del usuario.*
- [ ] R25 (M) **PR real** con `gh` y con el MCP de GitHub, más el reintento de la ruta MCP del PR (pendiente del equipo).
- [ ] R26 (S) **Sincronización real con Jira:** comentar y mover el estado (`syncStatus`).
- [ ] R27 (L) **OAuth de Atlassian (opcional):** solo si se decide usar el servidor remoto oficial.
- [ ] R28 (M) **Windows real:** Git Bash, rutas, `npm link` y teclas en modo raw; checklist y correcciones; arreglar el test frágil del timeout de bash (pendiente del equipo).
- [ ] R29 (M) **`agente doctor`:** diagnostica Node ≥ 22.9, git, `gh`, claves, red hacia el proveedor, conexión MCP y ventana del modelo.
- [ ] R30 (S) **Modo no interactivo (`--json`):** salida estructurada para scripts y CI.

## Fase 7 — Calidad medida
- [ ] R31 (S) **Umbral de cobertura** en `src/agent`, `src/workflow`, `src/tools` y `permissions.ts`, con informe en el CI.
- [ ] R32 (M) **Pruebas de rendimiento ligeras:** sesión simulada de 500 mensajes (guardado y compactación) y arranque en menos de 1 s sin MCP (conexión perezosa de servidores).
- [ ] R33 (M) **`docs/ARQUITECTURA.md`:** diagrama, decisiones, límites conocidos y glosario.
- [ ] R34 (S) **Deuda restante:** los avisos `useTemplate` de Biome y revisión final de lint.

## Fase 8 — Entrega
- [ ] R35 (M) **README renovado:** demo grabada (asciinema y GIF), capturas de cada diálogo y sección de limitaciones.
- [ ] R36 (M) **Guion de demo y modo sin red:** `npm run demo` reproduce una sesión con modelo y tracker simulados (indicado claramente como simulación) como plan B si falla la red o el límite gratuito.
- [ ] R37 (M) **Publicación en npm:** `files`, `bin`, `prepublishOnly`, nombre disponible, `npx agente`; versionado semántico, `CHANGELOG` desde commits convencionales y flujo de publicación.
- [ ] R38 (S) **Hoja de una página** para la defensa (resumen, diagrama y preguntas frecuentes).

## Mapa de archivos (cada archivo grande se edita en una sola fase)
| Archivo | Se edita en |
|---|---|
| `cli.ts` | R02 (queda delgado) |
| `chat.ts` | R02 (despachador) y R17 (entrada) |
| `agent/loop.ts` | R05 |
| `turn.ts` | R05 (ganchos); R12, R13, R14 y R19 se registran sin editarlo |
| `agent/compaction.ts` | R07 |
| `session.ts` | R08 (R10 añade un módulo aparte) |
| `agent/system.ts` | R11 (por secciones; R19 y R21 añaden secciones) |
| `config.ts` | R04 |
| `ui/render.ts`, `ui/dialog.ts` | R15 y R16 |
| `tools/guarded.ts` | R20 |
| `permissions.ts` | R01 (tipos) y R22 |

## Decisiones que necesito del usuario
1. **R03:** ¿se acepta una dependencia de desarrollo con binarios nativos para las pruebas de terminal?
2. **R20:** ¿se implementa el aislamiento del shell o se deja como trabajo futuro documentado?
3. **R27:** ¿se usará el servidor remoto oficial de Atlassian (OAuth) o basta con el token de API?
4. **R37:** nombre del paquete en npm y si se publica de verdad.
5. **R06:** tabla de precios: se mantiene a mano y puede quedar desactualizada; ¿se muestra el coste como "aproximado"?
6. **R24 a R26:** token de Jira y clave de modelo sin límites para las verificaciones reales.

## Ruta corta si hay poco tiempo antes de la defensa
R05 → R06 → R12 → R15/R16 (solo diff coloreado, % de contexto y progreso) → R09 → R35 → R36.
Costo: `render.ts` se edita después otra vez en la ruta larga; es el precio de ir más rápido.

## Verificación
`npm run lint` · `npm run typecheck` · `npm test` · `npm run build` · `npm run test:e2e` (desde R03).
