# agente

Arnés de código para la consola: multi-modelo, con herramientas de archivos y shell, pensado para conectar MCPs (Jira, Trello, GitHub) y llevar una issue hasta el PR.

**Estado:** hitos 1 (núcleo), 2 (MCP) y 3 (flujo hasta la revisión) listos. Pendiente: commit, push y PR (hito 4).

## Uso

```bash
npm install
export GOOGLE_GENERATIVE_AI_API_KEY=...   # o ANTHROPIC_API_KEY / OPENAI_API_KEY
npm run dev                                # chat interactivo en el directorio actual
npm run dev -- -p "explica src/config.ts"  # un solo turno
npm run dev -- -m anthropic/<modelo>       # cambiar de modelo
```

Comandos: `agente` (chat), `agente work <issue>`, `agente issues`, `agente init`. Ver `agente --help`.

Dentro del chat: `/model <prov/modelo>`, `/role <plan|implement|light>`, `/mcp`, `/clear`, `/exit`.

## Modelos

Formato `proveedor/modelo`: `google`, `anthropic`, `openai`, `ollama` (local), o cualquier endpoint OpenAI-compatible definido en `providers` con `baseURL`.
Cada **rol** puede usar un modelo distinto (`plan` para planificar, `implement` para escribir código, `light` para tareas baratas). Ver `agente.config.example.json` (cópialo a `agente.config.json`).

## Seguridad

- Las herramientas solo operan dentro del directorio del proyecto.
- Editar/escribir archivos y ejecutar comandos pide confirmación, salvo la lista `allowedCommands` (solo lectura/tests) o `--yes`.
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

Al terminar los cambios quedan **sin commit**; commit, push y PR llegan en el hito 4. Cada ejecución guarda su plan en `.git/agente/runs/`.

La issue puede ser `PROJ-123`, `#45` o una URL (la lee el modelo vía MCP), un archivo `.md` (primera línea = título) o texto libre. `agente issues` lista las del tracker y te deja elegir.

### Personalizar

- `agente init` crea `agente.config.json` y copia los prompts de cada etapa a `.agente/prompts/*.md` (`plan`, `implement`, `fix`, `issue-fetch`, `issue-list`). Edítalos y versiónalos con el repo; variables: `{{issue.key}}`, `{{issue.title}}`, `{{issue.body}}`, `{{plan}}`, `{{branch}}`, `{{verify.command}}`, `{{verify.output}}`.
- `workflow` en la config: `branchPrefix`, `isolation`, `worktreeDir`, `setup`, `verify` (tus propios comandos; `[]` desactiva), `maxFixAttempts`, `issueQuery`.
- Un modelo distinto por etapa con `roles` (`plan` / `implement` / `light`).
