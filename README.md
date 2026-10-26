# agente

Arnés de código para la consola: multi-modelo, con herramientas de archivos y shell, pensado para conectar MCPs (Jira, Trello, GitHub) y llevar una issue hasta el PR.

**Estado:** hitos 1 (núcleo) y 2 (MCP) listos. Pendiente: flujo issue → PR (hitos 3-4).

## Uso

```bash
npm install
export GOOGLE_GENERATIVE_AI_API_KEY=...   # o ANTHROPIC_API_KEY / OPENAI_API_KEY
npm run dev                                # chat interactivo en el directorio actual
npm run dev -- -p "explica src/config.ts"  # un solo turno
npm run dev -- -m anthropic/<modelo>       # cambiar de modelo
```

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
