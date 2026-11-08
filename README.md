# agente

Arnés de código para la consola: multi-modelo, con herramientas de archivos y shell, pensado para conectar MCPs (Jira, Trello, GitHub) y llevar una issue hasta el PR.

**Estado:** hitos 1 a 4 listos: del issue al PR y la sincronización con el tracker.

## Requisitos

- Node.js 22.9 o superior y git.
- **Windows:** el agente ejecuta los comandos con `bash`, así que necesita [Git for Windows](https://git-scm.com/download/win) (Git Bash) en el `PATH`.
- Para abrir PR automáticamente: [`gh`](https://cli.github.com) autenticado (`gh auth login`) o un servidor MCP de GitHub. Sin ninguno de los dos, `ship` deja el enlace y la descripción para abrirlo a mano.
- Una clave de modelo en el entorno: `GOOGLE_GENERATIVE_AI_API_KEY`, `ANTHROPIC_API_KEY` u `OPENAI_API_KEY`. Nunca la guardes en `agente.config.json`.

## Instalación como comando

```bash
npm install && npm run build
npm link        # deja el comando `agente` disponible en cualquier directorio
agente --help
```

## Demo sin red

`npm run demo` ejecuta un modelo simulado local y muestra al agente delegando en un subagente. Más: [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) y [`docs/HOJA-DEFENSA.md`](docs/HOJA-DEFENSA.md).

## Desarrollo

```bash
npm run lint       # Biome: lint y formato (npm run format aplica correcciones)
npm run typecheck
npm test
```

La integración continua (`.github/workflows/ci.yml`) ejecuta lo mismo en Linux y Windows. Las reglas del proyecto están en `AGENTE.md`.

## Uso

```bash
npm install
export GOOGLE_GENERATIVE_AI_API_KEY=...   # o ANTHROPIC_API_KEY / OPENAI_API_KEY
npm run dev                                # chat interactivo en el directorio actual
npm run dev -- -p "explica src/config.ts"  # un solo turno
npm run dev -- -m anthropic/<modelo>       # cambiar de modelo
```

Comandos: `agente` (chat), `agente work <issue>`, `agente ship`, `agente issues`, `agente init`. Ver `agente --help`.

Dentro del chat: `/model <prov/modelo>`, `/role <plan|implement|light>`, `/mcp`, `/clear`, `/exit`.

## Modelos

Formato `proveedor/modelo`: `google`, `anthropic`, `openai`, `ollama` (local), o cualquier endpoint OpenAI-compatible definido en `providers` con `baseURL`.
Cada **rol** puede usar un modelo distinto (`plan` para planificar, `implement` para escribir código, `light` para tareas baratas). Ver `agente.config.example.json` (cópialo a `agente.config.json`).

## Seguridad

- Las herramientas solo operan dentro del directorio del proyecto.
- Editar/escribir/borrar/mover archivos y ejecutar comandos pide confirmación (con vista previa del cambio), salvo la lista `allowedCommands` (solo lectura/tests). `--yes` aprueba planes y ediciones, pero no los comandos fuera de esa lista: esos siempre piden confirmación (sin terminal interactiva se deniegan).
- Los comandos encadenados (`;`, `|`, `$()`...) siempre preguntan.
- Bloqueados incluso con `--yes`: `sudo`/`doas` (también ofuscados con comillas o barras), `git push` forzado, con `+rama`, `--mirror` o `--delete` (aunque haya opciones globales como `git -C . push`), `rm -r` sobre `/`, `~`, `$HOME`, `.` o `..`, `curl | sh`, `mkfs`, `dd of=/dev/…` y `shutdown`.
- Un comando de la lista blanca pregunta igualmente si apunta fuera del proyecto (`/`, `~`, `..`), a archivos con secretos (`.env`, `*.pem`, `id_rsa`, `.ssh`…) o usa opciones que escriben o ejecutan (`--output`, `--ext-diff`, `--script-shell`, `--prefix`…). Se evalúa como lo ve el shell: `.e"n"v` es `.env` y los comodines que puedan alcanzar secretos (`.e[n]v`, `.e*`, `*.pem`) también preguntan.
- Límite conocido: la clasificación es por texto, no interpreta el shell completo. Con `--yes` se aprueban todas las ediciones, así que no lo uses con modelos o repositorios que no controlas.
- `AGENTE.md` (o `AGENTS.md`) en la raíz se añade al prompt como instrucciones del proyecto.

## MCP

Declara servidores en `mcpServers` (ver `agente.config.example.json`):

- **Local (stdio):** `command`, `args`, `env`.
- **Remoto:** `url`, `transport` (`http` por defecto o `sse`), `headers`.
- Los valores admiten `${VARIABLE}` del entorno, así los tokens no se guardan en el archivo. Los procesos stdio no heredan tus claves de modelos, solo lo que pongas en `env`.
- Las herramientas llegan al modelo como `mcp__<servidor>__<herramienta>`.
- **Piden confirmación por defecto.** Usa `autoApprove` con una lista de herramientas (p. ej. solo las de lectura) o `true` para todas.
- **Menos herramientas, menos tokens.** Cada herramienta que se expone ocupa tokens en todos los turnos (y los modelos gratuitos tienen un tope por minuto). `includeTools` deja solo las que listes (nombres originales del servidor) y `excludeTools` quita las que no quieras. Sin ninguna de las dos, se exponen todas.
- Si un servidor falla al conectar, se avisa y el resto sigue funcionando. `/mcp` muestra el estado y las herramientas. Lo que el servidor escribe por stderr no sale por pantalla: va a `~/.agente/logs/mcp-<servidor>.log`.

## Sesión interactiva

`agente` (sin argumentos) abre una sesión al estilo Claude Code en el proyecto actual: puedes **preguntarle cosas del código**, pedirle **cambios puntuales** o lanzar **el flujo completo** de una issue, todo en la misma conversación.

```
● Leer(src/math.js)
  ⎿  Leídas 4 líneas
● Editar(src/math.js)
╭─ Editar archivo ────────────────────────────────────────────╮
│ src/math.js                                                  │
│ - return a + b;                                              │
│ + return Number(a) + Number(b);                              │
│ ¿Quieres aplicar este cambio?                                │
│ ❯ 1. Sí                                                      │
│   2. Sí, no volver a preguntar por las ediciones en esta sesión │
│   3. No, y decirle al agente qué hacer distinto              │
╰──────────────────────────────────────────────────────────────╯
```

- **Permisos con opciones:** cada edición, borrado, comando, herramienta MCP o lectura web muestra qué va a hacer, con vista previa del cambio. Elige con ↑↓ y Enter, o pulsa el número. La opción 2 recuerda el permiso **solo durante la sesión** (todas las ediciones, un comando concreto, una herramienta MCP o un dominio); los comandos encadenados, que salen del proyecto o tocan secretos nunca la ofrecen. La opción 3 rechaza y le dice al agente qué hacer distinto: él recibe tu indicación.
- **Comandos:** `/work <issue>`, `/issues` (eliges con flechas), `/ship [rama]`, `/model`, `/role`, `/mcp`, `/status`, `/clear`, `/sessions`, `/resume [id]`, `/help`, `/exit`.
- **Sesiones guardadas:** cada conversación se guarda tras cada turno (en `.git/agente/sessions`, así no ensucia el árbol de trabajo; fuera de un repo, en `~/.agente/sessions`) y se conservan las 30 últimas por proyecto. `agente sessions` las lista, `agente -c` retoma la más reciente, `agente --resume` (sin id) te deja elegir de la lista con las flechas y `agente --resume <id>` retoma una concreta (basta el principio del id). Dentro del chat: `/sessions` y `/resume [id]`. `/clear` empieza una conversación nueva y deja la anterior guardada. Al retomar, el contexto vuelve tal como estaba (ya compactado si lo estaba). Con `-p` no se guarda, salvo que retomes una sesión.
- **Memoria más robusta:** si un turno falla o lo interrumpes con Esc, el trabajo que sí se completó (herramientas ejecutadas y sus resultados) se conserva en la sesión con una nota, en vez de perderse. En disco los **secretos se ocultan** (claves de Google, Atlassian, OpenAI, GitHub, Slack, AWS, tokens `Bearer`, líneas de `.env`, claves privadas) y los archivos son solo legibles por ti. Cuando la conversación se compacta, el **original de lo resumido o podado se archiva** en `archive/` (junto a las sesiones, también sin secretos).
- **Memoria del flujo:** cuando `/work`, `/issues` o `/ship` terminan (entregado, cancelado o detenido), la conversación guarda un registro de lo que pasó (issue, rama, verificación, plan aprobado, commit, push y PR). El modelo lo recuerda en los turnos siguientes y al retomar la sesión. Si el modelo lanza el flujo por su cuenta, el registro vuelve como resultado de la herramienta. El registro lleva solo la clave y el título de la issue, nunca su cuerpo (viene de un tracker externo y no debe colarse como instrucciones).
- **Memoria que tú decides (`/remember`):** `/remember usa pnpm, no npm` guarda una nota en la sección «Memoria del agente» de `AGENTE.md` del proyecto (se versiona con el repo); `/remember -u prefiero respuestas cortas` la guarda en tu memoria personal (`~/.agente/memory.md`, solo legible por ti, vale en todos tus proyectos). El modelo la ve desde el turno siguiente, sin reiniciar. `/memory` lista las notas y `/memory forget N [-u]` borra una. Solo la escribes tú: el modelo nunca guarda memoria por su cuenta (una nota persistente escrita desde una issue o una web sería una vía de inyección de instrucciones), y las notas que parecen un secreto se rechazan.
- **Gestionar y buscar sesiones:** `/search texto` (o `agente sessions texto`) busca dentro de todas las conversaciones del proyecto, también en lo que leyeron o ejecutaron las herramientas, y muestra el fragmento. `/sessions rename <id> <título>`, `/sessions export <id>` (Markdown en `.git/agente/sessions/exports/`) y `/sessions delete <id>`; no se puede borrar la sesión activa ni referirse a «la última» sin id, para evitar accidentes.
- **En lenguaje natural:** si le pides resolver una issue completa, el agente puede iniciar el flujo por su cuenta (te lo pregunta antes).
- **Teclas:** `Esc` o `Ctrl+C` interrumpen al modelo; `Ctrl+C` dos veces en reposo sale. Las decisiones del flujo (aprobar el plan, aceptar el diff, commit, push, PR) usan el mismo selector.
- Sin terminal interactiva (pipes, CI) los diálogos rechazan por seguridad; usa `--yes` o `--ship`. Los colores se desactivan con `NO_COLOR`.

## El flujo de un día normal

Desde la carpeta de cualquier proyecto git, con el comando corto:

```
agente                      abre la sesión y espera un prompt o un comando
/connect jira               (solo la primera vez) conecta tu tracker; vale para todos tus proyectos
/issues                     lista las pendientes → eliges una con ↑↓ y Enter
¿Quieres explicar algo más? escribes contexto, restricciones, archivos a tocar… (Enter para seguir)
Plan                        el agente investiga y propone el plan → apruebas, pides cambios (y lo regenera) o cancelas
Implementación              rama nueva, código, verificación automática (lint, tipos, tests) con corrección solo
Revisión                    ves el diff → aceptas, pides cambios o descartas
Entrega                     "¿commit y push a la rama?" → add, commit (mensaje propuesto) y push
Pull request                "¿abrir el PR?" → sí o no; si sí, comenta la issue y la mueve de estado
```

Cada paso es una decisión con opciones; con `Esc` cancelas. Para usarlo en cualquier carpeta: `npm run build && npm link` (deja el comando `agente` en el PATH). La configuración que escribe `/connect` va a `~/.agente/config.json` y se combina con la de cada proyecto (`agente.config.json`, que manda si define lo mismo).

## Primera vez: clave y tracker sin editar JSON

- **`agente` detecta si falta la clave** del modelo y te guía: dónde crearla (Gemini, Claude, OpenAI), te la pide **sin mostrarla** (solo `•`), la **comprueba contra el proveedor** y la guarda en `~/.agente/credentials` (permisos 600, fuera de cualquier repositorio; `AGENTE_HOME` cambia la carpeta). Lo exportado en tu entorno siempre manda. Más tarde: `/login`.
- **`/connect jira|trello|github`** (o `agente connect jira`): te dice cómo conseguir el token, pide los datos, guarda el token igual que la clave, **prueba la conexión**, separa las herramientas de **lectura** de las de **escritura** (te propone que las de lectura no pregunten; las de escritura siguen preguntando) y escribe la sección `mcpServers` en la configuración **global** (`~/.agente/config.json`) con `${VARIABLE}`, nunca con el secreto: conectas una vez y sirve en todos tus proyectos. Las herramientas quedan disponibles al instante, sin reiniciar.
- Servidores usados: Jira `@aashari/mcp-server-atlassian-jira` (token de API de Atlassian), Trello `@delorenj/mcp-server-trello` (API Key y token) y GitHub, el servidor MCP remoto oficial (token personal con permiso de Issues y Pull requests). Se descargan con `npx` la primera vez, que puede tardar.
- **No soportado:** OAuth con navegador (p. ej. el servidor remoto oficial de Atlassian); por eso Jira se conecta con un servidor local y token de API.

## Menos teclas

- **Atajos:** `agente PROJ-123` (también `#45`, una URL o un `.md`) arranca el flujo directo, sin escribir `work`. `agente "explica el módulo de pagos"` abre la sesión con esa pregunta. Si te equivocas en un comando (`agente isues`) te sugiere el correcto.
- **`/work` sin argumentos** abre la lista de issues (`/issues`).
- **Modos de permisos con Shift+Tab** (se ve en la regla sobre la entrada y con `/mode`): *preguntar* (diálogo en cada cambio), *aceptar ediciones solas* (editar y crear archivos sin preguntar; borrar, mover y comandos siguen preguntando) y *solo plan* (ningún cambio ni comando; el agente solo investiga y propone). Nunca saltan lo bloqueado por seguridad.
- **En el plan del flujo** hay una opción "Sí, y aceptar las ediciones solas durante este flujo": vale solo para ese flujo y el modo anterior se restaura al terminar.
- **Tab** completa comandos (`/mo` → `/mode`), claves de issues tras `/work`, ramas tras `/ship`, modelos tras `/model`, roles y modos. **↑** recupera lo que escribiste, también de sesiones anteriores (`~/.agente/history`, solo legible por ti; cambia la carpeta con `AGENTE_HOME`).

## Flujo `agente work`

Es el mismo flujo que usan los demás arneses de código:

```
issue → 1 PLAN → 2 RAMA → 3 IMPLEMENTACIÓN + VERIFICACIÓN → 4 REVISIÓN
```

1. **Plan** (modelo del rol `plan`, solo lectura): propone el plan. Lo apruebas con `a`, lo cancelas con `x`, o escribes qué cambiar y lo regenera. Aún no se ha creado nada.
2. **Rama**: `feat/<clave>-<título>`. Por defecto en tu repo (exige árbol limpio). Con `--worktree` (o `workflow.isolation: "worktree"`) trabaja en una copia aislada en `../<repo>-worktrees/` e instala las dependencias.
3. **Implementación** (rol `implement`) y **verificación**: tras implementar, el flujo ejecuta tú mismo los comandos (no el modelo): lint → typecheck → test, detectados de `package.json` (también `cargo test`, `go test`). Si fallan, el modelo recibe la salida y corrige, hasta `maxFixAttempts` veces.
4. **Revisión**: ves el diff; aceptas con `a`, descartas con `x` (te muestra los comandos de limpieza), o pides cambios escribiéndolos (se vuelve a verificar).

Al terminar, `work` pregunta si entregar de inmediato; si no, los cambios quedan sin commit y los entregas después con `agente ship`. Cada ejecución guarda issue, plan y resultado en `.git/agente/runs/`.

La issue puede ser `PROJ-123`, `#45` o una URL (la lee el modelo vía MCP), un archivo `.md` (primera línea = título) o texto libre. `agente issues` lista las del tracker y te deja elegir.

### Personalizar

- `agente init` crea `agente.config.json` y copia los prompts de cada etapa a `.agente/prompts/*.md` (`plan`, `implement`, `fix`, `issue-fetch`, `issue-list`). Edítalos y versiónalos con el repo; variables: `{{issue.key}}`, `{{issue.title}}`, `{{issue.body}}`, `{{plan}}`, `{{branch}}`, `{{verify.command}}`, `{{verify.output}}`.
- `workflow` en la config: `branchPrefix`, `isolation`, `worktreeDir`, `setup`, `verify` (tus propios comandos; `[]` desactiva), `maxFixAttempts`, `issueQuery`, `tracker` (nombre del servidor MCP de tus issues, p. ej. `"jira"`: con Jira y GitHub conectados a la vez, `agente issues` y la sincronización solo usan ese servidor; el PR sigue usando el de GitHub).
- Un modelo distinto por etapa con `roles` (`plan` / `implement` / `light`).

## Entrega: `agente ship`

Después de `work` (o con `agente work ... --ship` de una vez, sin confirmaciones intermedias):

```
5 COMMIT → 6 PUSH → 7 PULL REQUEST → 8 TRACKER
```

- **Commit:** el rol `light` redacta un mensaje Conventional Commits en español a partir del diff; lo apruebas, lo rechazas o pides cambios. Los archivos que parecen secretos (`.env`, `*.pem`, `id_rsa*`…) nunca se añaden ni se envían al modelo. Los hooks de git se respetan.
- **Push:** `git push -u <remoto> <rama>`, nunca `--force`. Solo reintenta ante fallos de red (2 s, 4 s, 8 s, 16 s). No se entrega desde `main`/`master`, la rama base ni `protectedBranches`.
- **PR:** método `auto`: `gh` si está autenticado → herramienta MCP de PR (p. ej. el MCP de GitHub) → enlace para abrirlo a mano con la descripción ya guardada. Usa `.github/pull_request_template.md` si existe. `--draft` lo abre como borrador.
- **Tracker:** si la issue vino de un tracker, comenta el enlace del PR por MCP y, con `workflow.syncStatus` (p. ej. `"In Review"`), mueve su estado. Si falla, el PR sigue creado y solo se avisa.
- **`--yes` no sube nada:** aprueba planes y ediciones, pero push y PR piden confirmación salvo con `--ship`.

### Sin coautores

Ningún commit, mensaje de PR ni comentario lleva `Co-Authored-By`, `Claude-Session` ni líneas "Generated with": se eliminan del texto del modelo por código y, si un hook de git añade una coautoría, se corrige el commit local antes del push. El autor es siempre tu `git config user.name/user.email`.

Opciones en `workflow`: `remote`, `protectedBranches`, `pushRetries`, `pr.method` (`auto|gh|mcp|manual`), `pr.draft`, `sync`, `syncStatus`. Prompts editables: `commit.md`, `pr.md`, `sync.md`.

## Herramientas del agente

No se reescribieron: vienen de [`@openharness/core`](https://github.com/MaxGfeller/open-harness) (MIT) y este proyecto les pone por debajo un proveedor con seguridad (`src/tools/guarded.ts`: rutas limitadas al proyecto, confirmaciones y vista previa, lista blanca de comandos).

| Herramienta | Origen |
|---|---|
| `readFile`, `writeFile`, `editFile`, `listFiles`, `grep`, `deleteFile`, `bash` | `@openharness/core` |
| `todowrite`, `todoread` (lista de tareas, se muestra en consola) | `@openharness/core` |
| herramientas MCP (`mcp__servidor__tool`) | `@ai-sdk/mcp` |
| `ask_user` (el modelo te pregunta si falta información) | propia, 15 líneas |
| `web_fetch` (lee una URL pública; bloquea redes internas; pide permiso por dominio) | propia |

Los archivos de configuración del proyecto (`package.json`, `tsconfig*.json`, `biome.json`, `agente.config.json`, `.npmrc`, `.github/workflows/`) **siempre piden confirmación** antes de editarse, incluso con `--yes` o en modo `edits`, y no ofrecen "no volver a preguntar". Así el modelo no puede cambiar en silencio cómo se valida o se construye el proyecto.

**Medidor de contexto.** La regla sobre el prompt muestra siempre `ctx ▰▰▱▱▱▱▱▱▱▱ 21 %` junto al modo (verde con holgura, amarillo al acercarse al umbral de compactación, rojo al alcanzarlo; `≈` mientras no hay dato real del proveedor). `/status` da el detalle en tokens y, cuando se compacta, el aviso enseña el antes y el después: `⇣ Contexto compactado ▰▰▰▰▰▰▰▰▱▱ 78 % → ▰▰▱▱▱▱▱▱▱▱ 21 %`.

### Modelo de respaldo

Con `"fallbackModel": "proveedor/modelo"` en la configuración, si el modelo principal agota la cuota o sigue fallando de forma temporal tras los reintentos, el turno continúa con el de respaldo desde donde se quedó (una sola vez, con aviso). No actúa ante errores de clave o de petición. Se ignora si falta la clave del respaldo.

### Subagentes

El modelo puede delegar investigaciones largas de solo lectura con la herramienta `delegate`: un subagente explora el código (`readFile`, `listFiles`, `grep`) con su **propio contexto** y devuelve un resumen, así el contexto principal no se llena de lecturas. No puede escribir, ejecutar comandos, preguntar ni leer la web, y su respuesta se marca como datos (no como instrucciones). Su actividad se ve anidada con `│`. Por defecto se ejecutan de una en una y usan el modelo del rol `light`.

```json
{ "subagents": { "enabled": true, "maxSteps": 12, "maxParallel": 1, "maxResultChars": 4000, "model": "google/gemini-2.5-flash" } }
```

Esc interrumpe también al subagente. Con `"enabled": false` la herramienta no se ofrece.

Ajustes sobre la librería: `editFile` escapa `$` del código nuevo (la librería lo interpretaba como patrón de `String.replace`) y exige que `oldString` sea único salvo `replaceAll`. `/status` muestra el uso real del contexto según el proveedor (`contexto: 2.069 / 256.000 tokens (1 %) · se compacta al 75 %`); la ventana se toma del modelo (ver `src/models.ts`) con un tope práctico de 256.000 tokens, y `contextWindow` en la configuración manda sobre ambos. La compactación de contexto (`contextWindow` (opcional), `compactAt`) poda resultados viejos de herramientas y luego resume; está escrita sobre el SDK v7 porque la de la librería usa su propia copia del SDK v6 y no acepta nuestros modelos.
