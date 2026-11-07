import type { createInterface } from 'node:readline/promises';
import { type ModelMessage, type ToolSet, tool } from 'ai';
import { z } from 'zod';
import { type CompactionEvent, estimateTokens } from './agent/compaction.js';
import { buildSystemPrompt } from './agent/system.js';
import { type Config, modelFor, ROLES, type Role } from './config.js';
import { currentBranch } from './git.js';
import type { McpConnections } from './mcp/client.js';
import { contextUsage, contextWindowFor, formatContext } from './models.js';
import { authorizeDetailed, denialMessage, MODE_LABEL, MODES, nextMode, type PermissionMode, type Permissions } from './permissions.js';
import { missingKeyHint } from './providers.js';
import { formatWhen, listSessions, loadSession, newSessionId, pruneSessions, type SessionRecord, saveSession, sessionTitle } from './session.js';
import { archiveCompaction } from './session-archive.js';
import { nativeTools } from './tools/index.js';
import { modelTurn } from './turn.js';
import { INTERRUPTED_NOTE, ModelTurnError } from './turn-error.js';
import { c } from './ui/ansi.js';
import type { CompletionState } from './ui/complete.js';
import { appendHistory } from './ui/history.js';
import type { Interrupt } from './ui/interrupt.js';
import type { Ui } from './ui/render.js';

/** Los flujos devuelven un registro de lo que hicieron (plan, rama, entrega…) para la memoria de la conversación. */
export interface ChatHandlers {
  /** Flujo completo para una issue (clave, URL, archivo o texto). */
  work(ref: string): Promise<string | undefined>;
  issues(): Promise<string | undefined>;
  ship(branch?: string): Promise<string | undefined>;
  /** Conexión guiada a Jira, Trello o GitHub. */
  connect(which?: string): Promise<void>;
  /** Pide y guarda la clave del proveedor del modelo indicado. */
  login(modelId: string): Promise<void>;
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
  /** Primer mensaje de la sesión (`agente "pregunta"`); después sigue interactiva. */
  initialPrompt?: string;
  /** Estado del autocompletado con Tab; la sesión lo mantiene al día. */
  completion: CompletionState;
  /** Archivo donde se guarda el historial de lo escrito (flecha arriba entre sesiones). */
  historyFile?: string;
  /** Carpeta donde se guarda la conversación tras cada turno. Sin ella, la sesión no se guarda. */
  sessionDir?: string;
  /** Sesión anterior que se retoma (--continue / --resume). */
  resume?: SessionRecord;
  handlers: ChatHandlers;
}

const COMMANDS: [string, string][] = [
  ['/work [issue]', 'Flujo completo: plan → rama → código → verificación → revisión. Sin argumento abre /issues'],
  ['/issues', 'Lista las issues del tracker (MCP) y te deja elegir una'],
  ['/ship [rama]', 'Commit → push → PR → actualiza el tracker'],
  ['/connect [jira|trello|github]', 'Conecta tu tracker paso a paso (guarda el token fuera del repo)'],
  ['/login', 'Pega la clave del proveedor del modelo actual (Gemini, Claude, OpenAI)'],
  ['/mode [ask|edits|plan]', 'Modo de permisos (Shift+Tab lo cambia): preguntar, aceptar ediciones solas, solo plan'],
  ['/model <prov/modelo>', 'Cambia de modelo'],
  ['/role <plan|implement|light>', 'Usa el modelo configurado para un rol'],
  ['/mcp', 'Estado y herramientas de los servidores MCP'],
  ['/status', 'Modelo, carpeta, rama y tamaño del historial'],
  ['/clear', 'Borra el historial de la conversación (la anterior queda guardada)'],
  ['/sessions', 'Conversaciones guardadas de este proyecto'],
  ['/resume [id]', 'Retoma una conversación guardada (sin id, la más reciente)'],
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
        // El registro del flujo vuelve al modelo como resultado de la herramienta: así recuerda qué se hizo.
        return (await handlers.work(issue)) ?? 'El flujo terminó (el usuario vio el resultado en pantalla).';
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
  const local: ToolSet = {
    ...nativeTools(cwd, perms, { onTodos: (t) => ui.todos(t) }),
    ...(d.prompt === undefined ? { start_workflow: workflowTool(perms, handlers) } : {}),
  };
  // Se arma en cada turno: así las herramientas de un tracker recién conectado (/connect) están disponibles al instante.
  const currentTools = (): ToolSet => ({ ...mcp.tools, ...local });
  let history: ModelMessage[] = d.resume?.messages ?? [];
  let sessionId = d.resume?.id ?? newSessionId();
  let sessionStart = d.resume?.createdAt ?? new Date().toISOString();
  let contextTokens = 0; // tamaño real del contexto según el proveedor, tras el último turno
  let saveFailed = false;
  let pruned = false;

  /** Guarda la conversación tras cada turno. Un fallo al guardar nunca interrumpe el chat: se avisa una vez. */
  const persist = async () => {
    if (!d.sessionDir || !history.length) return;
    try {
      await saveSession(d.sessionDir, {
        id: sessionId,
        cwd,
        title: sessionTitle(history),
        model: modelId,
        createdAt: sessionStart,
        updatedAt: new Date().toISOString(),
        messages: history,
      });
      if (!pruned) {
        pruned = true;
        await pruneSessions(d.sessionDir);
      }
    } catch (e) {
      if (!saveFailed) ui.warn(`No se pudo guardar la sesión: ${e instanceof Error ? e.message : e}`);
      saveFailed = true;
    }
  };

  /** Guarda el original de lo que la compactación resume o poda; un fallo al archivar nunca interrumpe el chat. */
  const archive = async (e: CompactionEvent) => {
    if (!d.sessionDir) return;
    try {
      await archiveCompaction(d.sessionDir, { sessionId, reason: e.reason, messages: e.original });
    } catch (err) {
      if (!saveFailed) ui.warn(`No se pudo archivar el original de la compactación: ${err instanceof Error ? err.message : err}`);
      saveFailed = true;
    }
  };

  const turn = async (input: string) => {
    history.push({ role: 'user', content: input });
    try {
      const { newMessages, usage } = await modelTurn(
        { config, ui, interrupt },
        { modelId, system, tools: currentTools(), messages: history, knownTokens: contextTokens, onCompact: archive },
      );
      history.push(...newMessages);
      contextTokens = usage.contextTokens;
      await persist();
    } catch (e) {
      const partial = e instanceof ModelTurnError ? e.partial : [];
      if (partial.length) {
        // Hubo trabajo hecho antes del fallo o de la interrupción: se conserva en la sesión (con una nota) en vez de perderlo.
        history.push(...partial, { role: 'assistant', content: INTERRUPTED_NOTE });
        await persist();
      } else history.pop();
      const aborted = e instanceof ModelTurnError ? e.interrupted : e instanceof Error && e.message.startsWith('Interrumpido');
      if (aborted) ui.notice(partial.length ? '(interrumpido; el trabajo ya hecho queda guardado en la sesión)' : '(interrumpido)');
      else if (d.prompt !== undefined) throw e;
      else ui.error(e instanceof Error ? e.message : String(e));
    }
  };

  if (d.prompt !== undefined) return turn(d.prompt);

  const branch = await currentBranch(cwd).catch(() => undefined);
  ui.banner({ model: modelId, cwd, branch, mcp: Object.keys(mcp.tools).length || undefined });
  if (!mcp.status.some((x) => x.ok)) ui.notice('Sin tracker conectado: /connect jira|trello|github');
  if (d.resume) ui.notice(`↻ Sesión retomada: «${d.resume.title}» (${d.resume.messages.length} mensajes, ${formatWhen(d.resume.updatedAt)})`);
  const modeLabel = () => `modo: ${MODE_LABEL[perms.mode ?? 'ask']} · Shift+Tab cambia`;
  d.completion.suppress = false;

  // Shift+Tab cambia el modo. Se escucha antes que readline para marcar que no es un Tab de completado.
  const onKey = (_s: string | undefined, key: { name?: string; shift?: boolean } | undefined) => {
    if (key?.name !== 'tab' || !key.shift) return;
    d.completion.suppress = true;
    perms.mode = nextMode(perms.mode ?? 'ask');
    ui.redrawRule(modeLabel(), rl.line.length);
  };
  if (process.stdin.isTTY) process.stdin.prependListener('keypress', onKey);

  if (d.initialPrompt) await turn(d.initialPrompt);

  const printMcp = () => {
    if (!mcp.status.length) return ui.notice('Sin servidores MCP configurados (mcpServers en agente.config.json).');
    for (const s of mcp.status) {
      ui.notice(s.ok ? `✓ ${s.name}: ${s.tools.length} herramientas` : `✗ ${s.name}: ${s.error}`);
      if (s.ok) for (const t of s.tools) ui.notice(`    ${t}`);
    }
  };

  const warnMissingKey = () => {
    const hint = missingKeyHint(modelId, config);
    if (hint) ui.warn(`Falta ${hint} para ${modelId}. Pégala con /login.`);
  };

  /** Línea de contexto de /status: el dato real del proveedor si existe; si no, una estimación (≈). */
  const statusContext = (): string => {
    const window = contextWindowFor(modelId, config.contextWindow);
    const real = contextTokens > 0;
    return formatContext(contextUsage(real ? contextTokens : estimateTokens(history), window, config.compactAt), !real);
  };

  const command = async (line: string): Promise<boolean> => {
    const [name = '', ...rest] = line.split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (name) {
      case '/exit':
      case '/salir':
      case '/quit':
        return false;
      case '/':
      case '/help':
      case '/?':
        ui.table(COMMANDS);
        break;
      case '/clear':
        history = [];
        contextTokens = 0;
        sessionId = newSessionId(); // la conversación anterior queda guardada; esta empieza aparte
        sessionStart = new Date().toISOString();
        pruned = false;
        ui.notice('Historial limpiado.');
        break;
      case '/sessions': {
        const dir = d.sessionDir;
        const list = dir ? await listSessions(dir) : [];
        if (!dir) ui.notice('Las sesiones no se guardan en este modo.');
        else if (!list.length) ui.notice('Todavía no hay sesiones guardadas en este proyecto.');
        else {
          ui.table(
            list
              .slice(0, 15)
              .map((s): [string, string] => [`${s.id === sessionId ? '● ' : '  '}${s.id}`, `${formatWhen(s.updatedAt)} · ${s.messages} msj · ${s.title}`]),
          );
          ui.notice(c.dim('Retoma una con /resume <id> (basta el principio del id).'));
        }
        break;
      }
      case '/resume': {
        const dir = d.sessionDir;
        if (!dir) ui.notice('Las sesiones no se guardan en este modo.');
        else
          await guarded(async () => {
            const rec = await loadSession(dir, arg || 'last', sessionId);
            history = rec.messages;
            contextTokens = 0; // el dato real se conocerá tras el siguiente turno
            sessionId = rec.id;
            sessionStart = rec.createdAt;
            pruned = false;
            ui.notice(`↻ Sesión retomada: «${rec.title}» (${rec.messages.length} mensajes, ${formatWhen(rec.updatedAt)})`);
          });
        break;
      }
      case '/mcp':
        printMcp();
        break;
      case '/status':
        ui.notice(
          `modelo: ${modelId}\nmodo: ${MODE_LABEL[perms.mode ?? 'ask']}\ncarpeta: ${cwd}${branch ? ` (${branch})` : ''}\nhistorial: ${history.length} mensajes\n${statusContext()}${d.sessionDir ? `\nsesión: ${sessionId}` : ''}`,
        );
        break;
      case '/mode':
        if (!arg) ui.notice(`Modo: ${MODE_LABEL[perms.mode ?? 'ask']}. Opciones: ${MODES.join(', ')} (o Shift+Tab)`);
        else if (!MODES.includes(arg as PermissionMode)) ui.warn(`Modo inválido. Opciones: ${MODES.join(', ')}`);
        else {
          perms.mode = arg as PermissionMode;
          ui.notice(`Modo: ${MODE_LABEL[perms.mode]}`);
        }
        break;
      case '/model':
        if (!arg) ui.notice(`Modelo actual: ${modelId}. Uso: /model <proveedor/modelo>`);
        else {
          modelId = arg;
          ui.notice(`Modelo: ${modelId}`);
          warnMissingKey();
        }
        break;
      case '/role':
        if (!ROLES.includes(arg as Role)) ui.warn(`Rol inválido. Opciones: ${ROLES.join(', ')}`);
        else {
          modelId = modelFor(config, arg as Role);
          ui.notice(`Modelo (${arg}): ${modelId}`);
          warnMissingKey();
        }
        break;
      case '/connect':
        await guarded(() => handlers.connect(arg || undefined));
        break;
      case '/login':
        await guarded(() => handlers.login(modelId));
        break;
      case '/work':
        await guarded(() => (arg ? handlers.work(arg) : handlers.issues()));
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

  /** Anota en la conversación lo que hizo un flujo, para que el modelo lo recuerde (también al retomar la sesión). */
  const recordFlow = async (summary: string) => {
    // Pareja usuario/asistente: mantiene la alternancia de roles que esperan los proveedores.
    history.push({ role: 'user', content: summary }, { role: 'assistant', content: 'Anotado: tengo en cuenta ese flujo.' });
    await persist();
  };

  const guarded = async (fn: () => Promise<unknown>) => {
    try {
      const summary = await fn();
      if (typeof summary === 'string' && summary) await recordFlow(summary);
    } catch (e) {
      ui.error(e instanceof Error ? e.message : String(e));
    }
  };

  for (;;) {
    let line: string;
    const quit = new AbortController();
    interrupt.onQuit(() => quit.abort());
    try {
      line = (await rl.question(ui.prompt(modeLabel()), { signal: quit.signal })).trim();
    } catch {
      break; // stdin cerrado o Ctrl+C repetido
    } finally {
      interrupt.onQuit(undefined);
    }
    if (!line) continue;
    if (d.historyFile) await appendHistory(d.historyFile, line);
    if (line.startsWith('/')) {
      if (!(await command(line))) break;
    } else await turn(line);
  }
  process.stdin.off('keypress', onKey);
  ui.notice(c.dim('Hasta pronto.'));
}
