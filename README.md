# agente

Arnés de código para la consola: multi-modelo, con herramientas de archivos y shell, pensado para conectar MCPs (Jira, Trello, GitHub) y llevar una issue hasta el PR.

**Estado:** hitos 1 a 4 listos: del issue al PR y la sincronización con el tracker.

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
- Editar/escribir/borrar/mover archivos y ejecutar comandos pide confirmación (con vista previa del cambio), salvo la lista `allowedCommands` (solo lectura/tests) o `--yes`.
- Los comandos encadenados (`;`, `|`, `$()`...) siempre preguntan; `sudo` y `git push --force` están bloqueados incluso con `--yes`.
- `AGENTE.md` (o `AGENTS.md`) en la raíz se añade al prompt como instrucciones del proyecto.

## MCP

Declara servidores en `mcpServers` (ver `agente.config.example.json`):

- **Local (stdio):** `command`, `args`, `env`.
- **Remoto:** `url`, `transport` (`http` por defecto o `sse`), `headers`.
- Los valores admiten `${VARIABLE}` del entorno, así los tokens no se guardan en el archivo. Los procesos stdio no heredan tus claves de modelos, solo lo que pongas en `env`.
- Las herramientas llegan al modelo como `mcp__<servidor>__<herramienta>`.
- **Piden confirmación por defecto.** Usa `autoApprove` con una lista de herramientas (p. ej. solo las de lectura) o `true` para todas.
- Si un servidor falla al conectar, se avisa y el resto sigue funcionando. `/mcp` muestra el estado y las herramientas.

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
- `workflow` en la config: `branchPrefix`, `isolation`, `worktreeDir`, `setup`, `verify` (tus propios comandos; `[]` desactiva), `maxFixAttempts`, `issueQuery`.
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

Ajustes sobre la librería: `editFile` escapa `$` del código nuevo (la librería lo interpretaba como patrón de `String.replace`) y exige que `oldString` sea único salvo `replaceAll`. La compactación de contexto (`contextWindow`, `compactAt`) poda resultados viejos de herramientas y luego resume; está escrita sobre el SDK v7 porque la de la librería usa su propia copia del SDK v6 y no acepta nuestros modelos.
