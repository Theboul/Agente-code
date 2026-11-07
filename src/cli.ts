#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { runChat } from './chat.js';
import { type Config, loadConfig, modelFor, ROLES, type Role } from './config.js';
import { type ConnectDeps, connectTracker, keyInstructions, loginProvider } from './connect/connect.js';
import { PRESETS } from './connect/presets.js';
import { applyCredentials } from './credentials.js';
import { currentBranch, git, repoRoot } from './git.js';
import { normalizeArgs, parseInvocation } from './invocation.js';
import { connectMcpServers, type McpConnections, toolsOfServer } from './mcp/client.js';
import { MODES, type Permissions } from './permissions.js';
import { missingKeyHint, PROVIDER_HELP } from './providers.js';
import { formatWhen, listSessions, loadSession, sessionsDir } from './session.js';
import { nativeTools, readOnlyTools } from './tools/index.js';
import { modelTurn } from './turn.js';
import { c, termWidth, truncate } from './ui/ansi.js';
import { box, wrapText } from './ui/box.js';
import { type CompletionState, createCompleter } from './ui/complete.js';
import { createDecisionPrompter, createPermissionPrompter } from './ui/dialog.js';
import { defaultHistoryFile, loadHistory } from './ui/history.js';
import { Interrupt } from './ui/interrupt.js';
import { Ui } from './ui/render.js';
import { selectIndex, stdinKeys } from './ui/select.js';
import { askJson, classifyRef, type Issue, IssueListSchema, IssueSchema, issueFromFile, issueFromText } from './workflow/issue.js';
import { makePrCreator } from './workflow/pr.js';
import { DEFAULT_PROMPTS, loadPrompt } from './workflow/prompts.js';
import { runWorkflow, type StageRunner } from './workflow/run.js';
import { findRun } from './workflow/runs.js';
import { type ShipResult, ship } from './workflow/ship.js';
import { type FlowOutcome, summarizeFlow } from './workflow/summary.js';
import { detectVerifyCommands } from './workflow/verify.js';

const HELP = `agente — arnés de código multi-modelo

Uso:
  agente                         Sesión interactiva en el directorio actual
  agente "pregunta"              Abre la sesión con ese primer mensaje
  agente PROJ-123                Atajo de "work": también #45, una URL o un archivo .md
  agente work <issue>            Flujo completo: plan → rama → implementación → verificación → revisión
                                 <issue> = PROJ-123 | #45 | URL (vía MCP), archivo .md/.txt, o texto libre
  agente ship [rama]             Commit → push → PR → sincroniza el tracker (tras "work")
  agente issues                  Lista issues del tracker (MCP), eliges una y sigue el flujo
  agente connect [jira|trello|github]   Conecta tu tracker paso a paso
  agente login                   Pega la clave de tu proveedor de modelos
  agente sessions                Lista las conversaciones guardadas de este proyecto
  agente init                    Crea agente.config.json y .agente/prompts/ para personalizar

Opciones:
  -m, --model <prov/modelo>   Usa este modelo en todas las etapas (ej. google/gemini-3.5-flash-lite)
  -r, --role <rol>            (chat) modelo del rol: ${ROLES.join(' | ')}
  -p, --prompt <texto>        (chat) un solo turno y salir
  -c, --continue              (chat) retoma la conversación más reciente de este proyecto
      --resume [id]           (chat) retoma una conversación concreta (ver: agente sessions); sin id, eliges de la lista
      --base <rama>           (work) rama base; por defecto la actual
      --worktree              (work) trabajar en un worktree aislado en vez de una rama en el repo
      --no-verify             (work) omitir la verificación automática
      --ship                  (work/ship) entregar sin confirmaciones intermedias (commit, push y PR)
      --draft                 (ship) abrir el PR como borrador
  -y, --yes                   Aprobar planes y ediciones sin preguntar (los comandos fuera de allowedCommands siguen pidiendo confirmación)
  -h, --help

Dentro de la sesión: /work, /issues, /ship, /connect, /login, /mode, /model, /role, /mcp, /status, /clear, /sessions, /resume, /help, /exit
  Tab completa comandos, issues y ramas · Shift+Tab cambia el modo de permisos · ↑ recupera lo escrito
Configuración: agente.config.json (ver README).`;

const dim = c.dim;

/** Una opción mal escrita o sin valor se explica en una línea, no con el stack trace de Node. */
function parseCli(args: string[]) {
  try {
    return parseArgs({
      args: normalizeArgs(args),
      allowPositionals: true,
      options: {
        model: { type: 'string', short: 'm' },
        role: { type: 'string', short: 'r' },
        prompt: { type: 'string', short: 'p' },
        continue: { type: 'boolean', short: 'c' },
        resume: { type: 'string' },
        base: { type: 'string' },
        worktree: { type: 'boolean' },
        'no-verify': { type: 'boolean' },
        ship: { type: 'boolean' },
        draft: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('. To specify')[0] : String(e);
    console.error(`${msg}\nMira las opciones con: agente --help`);
    process.exit(1);
  }
}

const { values, positionals } = parseCli(process.argv.slice(2));

const SLASH_COMMANDS = [
  '/work',
  '/issues',
  '/ship',
  '/remember',
  '/memory',
  '/mode',
  '/model',
  '/role',
  '/mcp',
  '/status',
  '/clear',
  '/sessions',
  '/resume',
  '/help',
  '/exit',
];

/** Ramas locales creadas por el flujo (con el prefijo configurado), para completar `/ship <Tab>`. */
async function localBranches(root: string, prefix: string): Promise<string[]> {
  const r = await git(root, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}*`]).catch(() => undefined);
  return r?.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

async function main() {
  if (values.help) return console.log(HELP);
  await applyCredentials();
  const cwd = process.cwd();
  const inv = parseInvocation(positionals, cwd);
  if (inv.suggest) {
    console.error(
      `"${positionals[0]}" no es un comando. ¿Quisiste decir \`agente ${inv.suggest}\`?\n(Para preguntarle eso al agente: agente "${positionals[0]} ...")`,
    );
    process.exitCode = 1;
    return;
  }
  const cmd = inv.cmd;
  if (cmd === 'init') return init(cwd);
  if (cmd === 'sessions') return printSessions(cwd);

  const config = await loadConfig(cwd);
  const root = (await repoRoot(cwd)) ?? cwd;
  // Autocompletado con Tab e historial entre sesiones (solo en una terminal interactiva).
  const completion: CompletionState = {
    commands: SLASH_COMMANDS,
    issues: [],
    branches: await localBranches(root, config.workflow.branchPrefix),
    models: [...new Set([config.model, ...Object.values(config.roles), 'anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-5-5'])],
    roles: [...ROLES],
    modes: [...MODES],
    trackers: PRESETS.map((p) => p.id),
    suppress: false,
  };
  const historyFile = process.stdin.isTTY && cmd === 'chat' ? defaultHistoryFile() : undefined;
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: createCompleter(() => completion),
    ...(historyFile ? { history: await loadHistory(historyFile), historySize: 500 } : {}),
  });
  const ui = new Ui();
  const interrupt = new Interrupt();
  // Ctrl+C: interrumpe el turno en curso; en reposo pide repetirlo para salir.
  let lastSigint = 0;
  rl.on('SIGINT', () => {
    if (interrupt.fire()) return;
    if (Date.now() - lastSigint < 2000 && interrupt.quit()) return;
    lastSigint = Date.now();
    ui.notice('Pulsa Ctrl+C otra vez para salir (o escribe /exit).');
  });

  const perms: Permissions = {
    mode: 'ask',
    autoApprove: values.yes ?? false,
    allowedCommands: [...config.allowedCommands, ...(config.workflow.verify ?? detectVerifyCommands(root))],
    confirm: async (q) => {
      if (!process.stdin.isTTY) return false;
      const a = await rl.question(`\n${q}\n[s/N] `);
      return /^(s|si|sí|y|yes)$/i.test(a.trim());
    },
  };
  perms.prompt = createPermissionPrompter({
    keys: stdinKeys(),
    out: process.stdout,
    ask: (q) => rl.question(q),
    interactive: () => Boolean(process.stdin.isTTY),
    onOpen: () => ui.idle(),
  });
  perms.ask = async (q) => {
    if (!process.stdin.isTTY) return undefined;
    return rl.question(`\n❓ ${q}\n› `);
  };
  const mcp = await connectMcpServers(config.mcpServers, perms);
  for (const s of mcp.status) if (!s.ok) ui.warn(`MCP ${s.name}: ${s.error}`);

  const ctx: Ctx = { cwd, root, config, perms, mcp, rl, ui, interrupt, completion };
  try {
    if (['chat', 'work', 'issues', 'ship'].includes(cmd) && values.prompt === undefined) await ensureKeys(ctx);
    if (cmd === 'chat') {
      // Las sesiones se guardan en el chat interactivo; con -p solo si se retoma una (para seguir la conversación).
      const wantsResume = values.continue || values.resume !== undefined;
      const sessionDir = values.prompt === undefined || wantsResume ? await sessionsDir(cwd) : undefined;
      let ref = values.resume;
      if (ref === '' && sessionDir) {
        const picked = await pickSession(sessionDir); // `--resume` sin id: se elige de la lista
        if (picked === 'cancel') return;
        ref = picked;
      }
      const resume = wantsResume && sessionDir ? await loadSession(sessionDir, ref ?? 'last') : undefined;
      await runChat({
        sessionDir,
        resume,
        cwd,
        config,
        perms,
        mcp,
        rl,
        ui,
        interrupt,
        model: values.model,
        role: values.role as Role | undefined,
        prompt: values.prompt,
        initialPrompt: inv.initialPrompt,
        completion,
        historyFile,
        handlers: {
          work: async (ref) => startWork(ctx, await resolveIssue(ctx, ref)),
          issues: () => issues(ctx),
          ship: (branch) => shipBranch(ctx, branch),
          connect: async (which) => void (await connectTracker(connectDeps(ctx), which)),
          login: async (modelId) => void (await loginProvider(connectDeps(ctx), modelId)),
        },
      });
    } else if (cmd === 'connect') {
      if (!process.stdin.isTTY) throw new Error('`agente connect` es interactivo: ejecútalo en una terminal.');
      await connectTracker(connectDeps(ctx), inv.args[0]);
    } else if (cmd === 'login') {
      if (!process.stdin.isTTY) throw new Error('`agente login` es interactivo: ejecútalo en una terminal o exporta la variable de la clave.');
      await loginProvider(connectDeps(ctx), values.model ?? modelFor(config, values.role ? (values.role as Role) : 'implement'));
    } else if (cmd === 'work') await work(ctx, inv.args);
    else if (cmd === 'ship') await shipBranch(ctx, inv.args[0]);
    else await issues(ctx);
  } finally {
    rl.close();
    await mcp.close();
  }
}

/**
 * `agente --resume` sin id: lista las conversaciones del proyecto y deja elegir una con las flechas.
 * Con una sola (o sin terminal interactiva) no hay nada que elegir: devuelve la más reciente.
 */
async function pickSession(dir: string): Promise<string | undefined> {
  const list = await listSessions(dir);
  if (list.length < 2 || !process.stdin.isTTY) return list[0]?.id;
  const choice = await selectIndex({
    count: list.length,
    keys: stdinKeys(),
    out: process.stdout,
    clear: true,
    render: (sel) => [
      ...box(
        list.map((s, n) => ({
          text: `${n === sel ? '❯' : ' '} ${formatWhen(s.updatedAt)} · ${String(s.messages).padStart(3)} msj · ${truncate(s.title, 50)}`,
          paint: n === sel ? c.cyan : (t: string) => t,
        })),
        { title: 'Conversaciones de este proyecto', width: termWidth(), border: c.cyan },
      ),
      c.dim('  ↑↓ elegir · Enter retomar · Esc salir'),
    ],
  });
  return choice === 'cancel' ? 'cancel' : list[choice]?.id;
}

/** `agente sessions`: conversaciones guardadas de este proyecto, la más reciente primero. */
async function printSessions(cwd: string) {
  const list = await listSessions(await sessionsDir(cwd));
  if (!list.length) return console.log('Todavía no hay conversaciones guardadas en este proyecto.');
  const w = Math.max(...list.map((s) => s.id.length)) + 2;
  for (const s of list) console.log(`${c.cyan(s.id.padEnd(w))}${formatWhen(s.updatedAt)} · ${String(s.messages).padStart(3)} msj · ${s.title}`);
  console.log(dim('\nRetoma la última con `agente -c` o una concreta con `agente --resume <id>` (basta el principio del id).'));
}

/** Pone a disposición de /connect y /login todo lo que necesitan de la sesión. */
function connectDeps(ctx: Ctx): ConnectDeps {
  return {
    cwd: ctx.cwd,
    ui: ctx.ui,
    rl: ctx.rl,
    keys: stdinKeys(),
    out: process.stdout,
    choose: workflowIO(ctx).choose,
    mcp: ctx.mcp,
    config: ctx.config,
  };
}

/** Primera ejecución: si a los modelos que se van a usar les falta la clave, ofrece pegarla ahora en lugar de fallar más tarde. */
async function ensureKeys(ctx: Ctx): Promise<void> {
  if (!process.stdin.isTTY) return;
  const ids = values.model ? [values.model] : [...new Set((['plan', 'implement', 'light'] as const).map((r) => modelFor(ctx.config, r)))];
  const asked = new Set<string>();
  for (const id of ids) {
    const hint = missingKeyHint(id, ctx.config);
    if (!hint || asked.has(hint)) continue;
    asked.add(hint);
    ctx.ui.warn(keyInstructions(id, ctx.config));
    const reply = await workflowIO(ctx).choose({
      title: `Falta la clave de ${PROVIDER_HELP[id.split('/')[0] ?? '']?.label ?? id.split('/')[0]}`,
      approve: 'Pegar la clave ahora',
      cancel: 'Más tarde (/login)',
    });
    if (reply.kind === 'approve') await loginProvider(connectDeps(ctx), id);
  }
}

interface Ctx {
  cwd: string;
  root?: string;
  config: Config;
  perms: Permissions;
  mcp: McpConnections;
  rl: ReturnType<typeof createInterface>;
  ui: Ui;
  interrupt: Interrupt;
  completion: CompletionState;
}

/** Un turno del agente para el flujo (plan, implementación, redacción…), con la salida visual de la sesión. */
function makeStageRunner(ctx: Ctx): StageRunner {
  const { config, perms, mcp, ui } = ctx;
  return async ({ role, system, tools, workdir, messages, quiet, server }) => {
    const modelId = values.model ?? modelFor(config, role);
    ui.notice(`\n✻ ${role} · ${modelId}`);
    const toolset =
      tools === 'none'
        ? {}
        : tools === 'readonly'
          ? readOnlyTools(workdir, perms)
          : tools === 'mcp'
            ? toolsOfServer(mcp.tools, server)
            : { ...toolsOfServer(mcp.tools, server), ...nativeTools(workdir, perms, { onTodos: (t) => ui.todos(t) }) };
    // Sin herramientas = redacción de commit/PR: se muestra ya limpia por el flujo, no el texto crudo del modelo.
    return modelTurn(ctx, { modelId, system, tools: toolset, messages, stream: tools !== 'none' && !quiet });
  };
}

/** Pide al modelo (con las herramientas MCP) un JSON; sin MCP configurado no hay tracker que consultar. */
async function askTracker(ctx: Ctx, prompt: string): Promise<unknown> {
  if (!Object.keys(ctx.mcp.tools).length) {
    throw new Error('No hay un tracker conectado. Conéctalo con /connect jira|trello|github (o `agente connect jira`), o pasa un archivo .md / texto libre.');
  }
  const server = ctx.config.workflow.tracker;
  if (server && !Object.keys(toolsOfServer(ctx.mcp.tools, server)).length) {
    throw new Error(`El tracker "${server}" (workflow.tracker) no está conectado o no expone herramientas. Mira /mcp o revisa mcpServers e includeTools.`);
  }
  const run = makeStageRunner(ctx);
  return askJson(async () => {
    const r = await run({
      server,
      role: 'light',
      system: 'Eres un asistente que consulta un gestor de tareas mediante herramientas MCP. Responde siempre en el formato pedido.',
      tools: 'full',
      workdir: ctx.cwd,
      messages: [{ role: 'user', content: prompt }],
      quiet: true,
    });
    return r.text;
  });
}

async function resolveIssue(ctx: Ctx, ref: string): Promise<Issue> {
  const c = classifyRef(ref, ctx.cwd);
  if (c.kind === 'file') return issueFromFile(c.path);
  if (c.kind === 'text') return issueFromText(c.text);
  const root = ctx.root ?? ctx.cwd;
  const json = await askTracker(ctx, await loadPrompt(root, 'issue-fetch', { ref: c.ref }));
  const issue = IssueSchema.parse(json);
  return { ...issue, key: issue.key ?? c.ref };
}

function workflowIO(ctx: Ctx) {
  const choose = createDecisionPrompter({
    keys: stdinKeys(),
    out: process.stdout,
    ask: (q) => ctx.rl.question(q),
    interactive: () => Boolean(process.stdin.isTTY),
    onOpen: () => ctx.ui.idle(),
  });
  return {
    choose,
    allowEdits: () => {
      ctx.perms.mode = 'edits';
    },
    say: (m: string) => console.log(m),
    ask: async (q: string) => {
      if (!process.stdin.isTTY) throw new Error('Se necesita una terminal interactiva para aprobar (o usa --yes / --ship).');
      return ctx.rl.question(q);
    },
  };
}

/** Ejecuta el flujo y devuelve el registro de lo que pasó (para la memoria de la conversación). */
async function startWork(ctx: Ctx, issue: Issue): Promise<string | undefined> {
  // "Aceptar las ediciones solas" elegido en el plan vale solo durante este flujo.
  const modeBefore = ctx.perms.mode;
  try {
    const outcome = await runWork(ctx, issue);
    return outcome ? summarizeFlow(outcome) : undefined;
  } finally {
    ctx.perms.mode = modeBefore;
  }
}

/** Muestra la issue elegida y deja explicar algo más (contexto, restricciones, archivos) antes del plan. Enter continúa. */
async function withExtraContext(ctx: Ctx, issue: Issue): Promise<Issue> {
  if (!process.stdin.isTTY || values.yes || values.ship) return issue;
  const body = wrapText(issue.body.trim() || '(sin descripción)', termWidth() - 6);
  const shown = body.length > 12 ? [...body.slice(0, 12), '…'] : body;
  console.log(box(shown, { title: `${issue.key ?? 'Tarea'} · ${truncate(issue.title, 60)}`, width: termWidth(), border: c.cyan }).join('\n'));
  const lines: string[] = [];
  let prompt = c.dim(
    '¿Quieres explicar algo más antes del plan? Contexto, restricciones, archivos a tocar… (Enter para continuar; termina con \\ para seguir en otra línea)\n› ',
  );
  for (;;) {
    const line = (await ctx.rl.question(prompt)).trimEnd();
    if (!line.endsWith('\\')) {
      if (line) lines.push(line);
      break;
    }
    lines.push(line.slice(0, -1).trimEnd());
    prompt = c.dim('… ');
  }
  const extra = lines.join('\n').trim();
  return extra ? { ...issue, body: `${issue.body}\n\n## Contexto adicional del usuario\n${extra}`.trim() } : issue;
}

async function runWork(ctx: Ctx, original: Issue): Promise<FlowOutcome | undefined> {
  const issue = await withExtraContext(ctx, original);
  const result = await runWorkflow({
    cwd: ctx.cwd,
    config: ctx.config,
    issue,
    base: values.base,
    worktree: values.worktree,
    yes: values.yes,
    noVerify: values['no-verify'],
    runStage: makeStageRunner(ctx),
    io: workflowIO(ctx),
  });
  const base: FlowOutcome = { issue, status: result.status, branch: result.branch, base: result.base, verified: result.verified, plan: result.plan };
  if (result.status !== 'ready') {
    process.exitCode = result.status === 'failed' ? 1 : 0;
    return base;
  }
  const now =
    values.ship ||
    (process.stdin.isTTY &&
      (
        await workflowIO(ctx).choose({
          title: 'Entrega',
          detail: [`Rama ${result.branch}`, 'Se hace add, commit y push a esa rama. El PR lo decides después.'],
          approve: 'Sí, hacer commit y push a la rama',
          cancel: 'No, lo entrego después (/ship)',
        })
      ).kind === 'approve');
  if (now) {
    const shipped = await deliver(ctx, {
      ...(result as Required<Pick<typeof result, 'branch' | 'workdir' | 'base' | 'issue' | 'plan'>> & typeof result),
      pushConfirmed: true,
    });
    return { ...base, ship: shipped };
  }
  console.log(`Cuando quieras entregarlo: agente ship ${result.branch}`);
  return base;
}

async function deliver(
  ctx: Ctx,
  r: { branch: string; workdir: string; base: string; issue: Issue; plan: string; verified?: boolean; runFile?: string; pushConfirmed?: boolean },
): Promise<ShipResult> {
  const runStage = makeStageRunner(ctx);
  const res = await ship({
    root: ctx.root ?? ctx.cwd,
    workdir: r.workdir,
    config: ctx.config,
    issue: r.issue,
    plan: r.plan,
    base: r.base,
    branch: r.branch,
    verified: r.verified,
    runFile: r.runFile,
    auto: values.ship,
    pushConfirmed: r.pushConfirmed,
    draft: values.draft,
    runStage,
    mcpToolNames: Object.keys(ctx.mcp.tools),
    createPr: makePrCreator({ method: ctx.config.workflow.pr.method, runStage, mcpToolNames: Object.keys(ctx.mcp.tools) }),
    io: workflowIO(ctx),
  });
  if (!res.pushed) process.exitCode = 1;
  return res;
}

async function shipBranch(ctx: Ctx, branchArg?: string): Promise<string | undefined> {
  const root = ctx.root;
  if (!root) throw new Error('Este directorio no es un repositorio git.');
  const branch = branchArg ?? (await currentBranch(root));
  const found = await findRun(root, branch);
  if (!found) throw new Error(`No hay una ejecución de \`agente work\` registrada para la rama "${branch}".`);
  const { rec, file } = found;
  const shipped = await deliver(ctx, { ...rec, workdir: existsSync(rec.workdir) ? rec.workdir : root, runFile: file });
  return summarizeFlow({ issue: rec.issue, status: rec.status, branch: rec.branch, base: rec.base, verified: rec.verified, plan: rec.plan, ship: shipped });
}

async function work(ctx: Ctx, args: string[]) {
  const ref = args.join(' ').trim();
  if (!ref) throw new Error('Indica la tarea: agente work PROJ-123 | archivo.md | "texto libre"');
  await startWork(ctx, await resolveIssue(ctx, ref));
}

async function issues(ctx: Ctx): Promise<string | undefined> {
  if (!process.stdin.isTTY) throw new Error('`agente issues` es interactivo; usa `agente work <issue>` en scripts.');
  const root = ctx.root ?? ctx.cwd;
  const json = await askTracker(ctx, await loadPrompt(root, 'issue-list', { query: ctx.config.workflow.issueQuery }));
  const list = IssueListSchema.parse(json);
  if (!list.length) {
    console.log('No hay issues que coincidan.');
    return undefined;
  }
  const choice = await selectIndex({
    count: list.length,
    keys: stdinKeys(),
    out: process.stdout,
    clear: true,
    render: (sel) => [
      ...box(
        list.map((i, n) => ({ text: `${n === sel ? '❯' : ' '} ${n + 1}. ${i.key ?? '-'}  ${i.title}`, paint: n === sel ? c.cyan : (t: string) => t })),
        { title: 'Issues disponibles', width: termWidth(), border: c.cyan },
      ),
      c.dim('  ↑↓ elegir · Enter trabajar en ella · Esc salir'),
    ],
  });
  ctx.completion.issues = list.flatMap((i) => (i.key ? [i.key] : []));
  if (choice === 'cancel') return undefined;
  const chosen = list[choice];
  if (!chosen) return undefined;
  return startWork(ctx, await resolveIssue(ctx, chosen.key ?? chosen.title));
}

/** Crea la config y los prompts editables sin pisar nada existente. */
async function init(cwd: string) {
  const created: string[] = [];
  const put = async (path: string, content: string) => {
    if (existsSync(path)) return console.log(dim(`existe: ${path}`));
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content);
    created.push(path);
  };
  await put(
    join(cwd, 'agente.config.json'),
    JSON.stringify(
      {
        model: 'google/gemini-3.5-flash-lite',
        roles: { plan: 'google/gemini-3.5-flash-lite', implement: 'google/gemini-3.5-flash-lite' },
        workflow: { branchPrefix: 'feat/', isolation: 'branch', maxFixAttempts: 3 },
        mcpServers: {},
      },
      null,
      2,
    ) + '\n',
  );
  for (const [name, text] of Object.entries(DEFAULT_PROMPTS)) await put(join(cwd, '.agente', 'prompts', `${name}.md`), text + '\n');
  console.log(created.length ? `Creado:\n${created.map((p) => `  ${p}`).join('\n')}` : 'Nada que crear.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
