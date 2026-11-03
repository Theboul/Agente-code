import type { createInterface } from 'node:readline/promises';
import { type ModelMessage, type ToolSet, tool } from 'ai';
import { z } from 'zod';
import { buildSystemPrompt } from './agent/system.js';
import { type Config, modelFor, ROLES, type Role } from './config.js';
import { currentBranch } from './git.js';
import type { McpConnections } from './mcp/client.js';
import { authorizeDetailed, denialMessage, type Permissions } from './permissions.js';
import { nativeTools } from './tools/index.js';
import { modelTurn } from './turn.js';
import { c } from './ui/ansi.js';
import type { Interrupt } from './ui/interrupt.js';
import type { Ui } from './ui/render.js';

export interface ChatHandlers {
  /** Flujo completo para una issue (clave, URL, archivo o texto). */
  work(ref: string): Promise<void>;
  issues(): Promise<void>;
  ship(branch?: string): Promise<void>;
}

export interface ChatDeps {
  cwd: string;
  config: Config;
  perms: Permissions;
  mcp: McpConnections;
  rl: ReturnType<typeof createInterface>;
  ui: Ui;
  interrupt: Interrupt;
  model?: string;
  role?: Role;
  /** Un solo turno y salir (-p). */
  prompt?: string;
  handlers: ChatHandlers;
}

const COMMANDS: [string, string][] = [
  ['/work <issue>', 'Flujo completo: plan → rama → código → verificación → revisión (PROJ-123, #45, URL, archivo .md o texto)'],
  ['/issues', 'Lista las issues del tracker (MCP) y te deja elegir una'],
  ['/ship [rama]', 'Commit → push → PR → actualiza el tracker'],
  ['/model <prov/modelo>', 'Cambia de modelo'],
  ['/role <plan|implement|light>', 'Usa el modelo configurado para un rol'],
  ['/mcp', 'Estado y herramientas de los servidores MCP'],
  ['/status', 'Modelo, carpeta, rama y tamaño del historial'],
  ['/clear', 'Borra el historial de la conversación'],
  ['/help', 'Esta ayuda'],
  ['/exit', 'Salir'],
];

const CHAT_RULES = `
- Estás en una sesión interactiva: el usuario puede pedirte preguntas sobre el proyecto o cambios puntuales; respóndelos directamente con tus herramientas.
- Si pide resolver una issue o tarea completa (con plan, rama, verificación y PR), usa start_workflow en lugar de hacerlo a mano.`;

/** Herramienta que permite al modelo lanzar el flujo completo cuando el usuario lo pide en lenguaje natural. */
export function workflowTool(perms: Permissions, handlers: ChatHandlers) {
  return tool({
    description:
      'Inicia el flujo completo de trabajo (plan → rama aislada → implementación → verificación → revisión) para una tarea. ' +
      'Úsala cuando el usuario pida implementar o resolver una issue entera. La issue puede ser una clave (PROJ-123), #45, una URL, una ruta a un .md o una descripción. ' +
      'Para preguntas o cambios pequeños usa las demás herramientas.',
    inputSchema: z.object({ issue: z.string().describe('Referencia o descripción de la tarea') }),
    execute: async ({ issue }) => {
      const reply = await authorizeDetailed(perms, 'ask', {
        kind: 'workflow',
        title: 'Iniciar flujo de trabajo',
        target: issue,
        question: `¿Iniciar el flujo completo para "${issue}"?`,
      });
      if (!reply.allow) return denialMessage(reply);
      try {
        await handlers.work(issue);
        return 'El flujo terminó (el usuario vio el resultado en pantalla).';
      } catch (e) {
        return `Error en el flujo: ${e instanceof Error ? e.message : e}`;
      }
    },
  });
}

/** Sesión interactiva al estilo Claude Code: conversación libre sobre el proyecto y comandos "/". */
export async function runChat(d: ChatDeps): Promise<void> {
  const { cwd, config, perms, mcp, rl, ui, interrupt, handlers } = d;
  let modelId = d.model ?? modelFor(config, d.role ?? 'implement');
  const system = `${await buildSystemPrompt(cwd)}${CHAT_RULES}`;
  const tools: ToolSet = {
    ...mcp.tools,
    ...nativeTools(cwd, perms, { onTodos: (t) => ui.todos(t) }),
    ...(d.prompt === undefined ? { start_workflow: workflowTool(perms, handlers) } : {}),
  };
  let history: ModelMessage[] = [];

  const turn = async (input: string) => {
    history.push({ role: 'user', content: input });
    try {
      const { newMessages } = await modelTurn({ config, ui, interrupt }, { modelId, system, tools, messages: history });
      history.push(...newMessages);
    } catch (e) {
      history.pop();
      const aborted = e instanceof Error && e.message.startsWith('Interrumpido');
      if (aborted) ui.notice('(interrumpido)');
      else if (d.prompt !== undefined) throw e;
      else ui.error(e instanceof Error ? e.message : String(e));
    }
  };

  if (d.prompt !== undefined) return turn(d.prompt);

  const branch = await currentBranch(cwd).catch(() => undefined);
  ui.banner({ model: modelId, cwd, branch, mcp: Object.keys(mcp.tools).length || undefined });

  const printMcp = () => {
    if (!mcp.status.length) return ui.notice('Sin servidores MCP configurados (mcpServers en agente.config.json).');
    for (const s of mcp.status) {
      ui.notice(s.ok ? `✓ ${s.name}: ${s.tools.length} herramientas` : `✗ ${s.name}: ${s.error}`);
      if (s.ok) for (const t of s.tools) ui.notice(`    ${t}`);
    }
  };

  const command = async (line: string): Promise<boolean> => {
    const [name = '', ...rest] = line.split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (name) {
      case '/exit':
      case '/salir':
      case '/quit':
        return false;
      case '/help':
      case '/?':
        ui.table(COMMANDS);
        break;
      case '/clear':
        history = [];
        ui.notice('Historial limpiado.');
        break;
      case '/mcp':
        printMcp();
        break;
      case '/status':
        ui.notice(`modelo: ${modelId}\ncarpeta: ${cwd}${branch ? ` (${branch})` : ''}\nhistorial: ${history.length} mensajes`);
        break;
      case '/model':
        if (!arg) ui.notice(`Modelo actual: ${modelId}. Uso: /model <proveedor/modelo>`);
        else {
          modelId = arg;
          ui.notice(`Modelo: ${modelId}`);
        }
        break;
      case '/role':
        if (!ROLES.includes(arg as Role)) ui.warn(`Rol inválido. Opciones: ${ROLES.join(', ')}`);
        else {
          modelId = modelFor(config, arg as Role);
          ui.notice(`Modelo (${arg}): ${modelId}`);
        }
        break;
      case '/work':
        if (!arg) ui.warn('Indica la tarea: /work PROJ-123 | archivo.md | descripción');
        else await guarded(() => handlers.work(arg));
        break;
      case '/issues':
        await guarded(() => handlers.issues());
        break;
      case '/ship':
        await guarded(() => handlers.ship(arg || undefined));
        break;
      default:
        ui.warn(`Comando desconocido: ${name}. Escribe /help.`);
    }
    return true;
  };

  const guarded = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      ui.error(e instanceof Error ? e.message : String(e));
    }
  };

  for (;;) {
    let line: string;
    const quit = new AbortController();
    interrupt.onQuit(() => quit.abort());
    try {
      line = (await rl.question(ui.prompt(), { signal: quit.signal })).trim();
    } catch {
      break; // stdin cerrado o Ctrl+C repetido
    } finally {
      interrupt.onQuit(undefined);
    }
    if (!line) continue;
    if (line.startsWith('/')) {
      if (!(await command(line))) break;
    } else await turn(line);
  }
  ui.notice(c.dim('Hasta pronto.'));
}
