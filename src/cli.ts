#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { runChat } from './chat.js';
import { type Config, loadConfig, modelFor, ROLES, type Role } from './config.js';
import { currentBranch, git, repoRoot } from './git.js';
import { parseInvocation } from './invocation.js';
import { connectMcpServers, type McpConnections } from './mcp/client.js';
import { MODES, type Permissions } from './permissions.js';
import { nativeTools, readOnlyTools } from './tools/index.js';
import { modelTurn } from './turn.js';
import { c, termWidth } from './ui/ansi.js';
import { box } from './ui/box.js';
import { type CompletionState, createCompleter } from './ui/complete.js';
import { createDecisionPrompter, createPermissionPrompter } from './ui/dialog.js';
import { defaultHistoryFile, loadHistory } from './ui/history.js';
import { Interrupt } from './ui/interrupt.js';
import { Ui } from './ui/render.js';
import { selectIndex, stdinKeys } from './ui/select.js';
import { classifyRef, extractJson, type Issue, IssueListSchema, IssueSchema, issueFromFile, issueFromText } from './workflow/issue.js';
import { makePrCreator } from './workflow/pr.js';
import { DEFAULT_PROMPTS, loadPrompt } from './workflow/prompts.js';
import { runWorkflow, type StageRunner } from './workflow/run.js';
import { findRun } from './workflow/runs.js';
import { ship } from './workflow/ship.js';
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
  agente init                    Crea agente.config.json y .agente/prompts/ para personalizar

Opciones:
  -m, --model <prov/modelo>   Usa este modelo en todas las etapas (ej. google/gemini-3.5-flash-lite)
  -r, --role <rol>            (chat) modelo del rol: ${ROLES.join(' | ')}
  -p, --prompt <texto>        (chat) un solo turno y salir
      --base <rama>           (work) rama base; por defecto la actual
      --worktree              (work) trabajar en un worktree aislado en vez de una rama en el repo
      --no-verify             (work) omitir la verificación automática
      --ship                  (work/ship) entregar sin confirmaciones intermedias (commit, push y PR)
      --draft                 (ship) abrir el PR como borrador
  -y, --yes                   Aprobar planes, ediciones y comandos sin preguntar
  -h, --help

Dentro de la sesión: /work, /issues, /ship, /mode, /model, /role, /mcp, /status, /clear, /help, /exit
  Tab completa comandos, issues y ramas · Shift+Tab cambia el modo de permisos · ↑ recupera lo escrito
Configuración: agente.config.json (ver README).`;

const dim = c.dim;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: 'string', short: 'm' },
    role: { type: 'string', short: 'r' },
    prompt: { type: 'string', short: 'p' },
    base: { type: 'string' },
    worktree: { type: 'boolean' },
    'no-verify': { type: 'boolean' },
    ship: { type: 'boolean' },
    draft: { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    help: { type: 'boolean', short: 'h' },
  },
});

const SLASH_COMMANDS = ['/work', '/issues', '/ship', '/mode', '/model', '/role', '/mcp', '/status', '/clear', '/help', '/exit'];

/** Ramas locales creadas por el flujo (con el prefijo configurado), para completar `/ship <Tab>`. */
async function localBranches(root: string, prefix: string): Promise<string[]> {
  const r = await git(root, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}*`]).catch(() => undefined);
  return r?.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

async function main() {
  if (values.help) return console.log(HELP);
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
    if (cmd === 'chat') {
      await runChat({
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
        },
      });
    } else if (cmd === 'work') await work(ctx, inv.args);
    else if (cmd === 'ship') await shipBranch(ctx, inv.args[0]);
    else await issues(ctx);
  } finally {
    rl.close();
    await mcp.close();
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
  return async ({ role, system, tools, workdir, messages }) => {
    const modelId = values.model ?? modelFor(config, role);
    ui.notice(`\n✻ ${role} · ${modelId}`);
    const toolset =
      tools === 'none'
        ? {}
        : tools === 'readonly'
          ? readOnlyTools(workdir, perms)
          : tools === 'mcp'
            ? mcp.tools
            : { ...mcp.tools, ...nativeTools(workdir, perms, { onTodos: (t) => ui.todos(t) }) };
    // Sin herramientas = redacción de commit/PR: se muestra ya limpia por el flujo, no el texto crudo del modelo.
    return modelTurn(ctx, { modelId, system, tools: toolset, messages, stream: tools !== 'none' });
  };
}

/** Pide al modelo (con las herramientas MCP) un JSON; sin MCP configurado no hay tracker que consultar. */
async function askTracker(ctx: Ctx, prompt: string): Promise<unknown> {
  if (!Object.keys(ctx.mcp.tools).length) {
    throw new Error('No hay herramientas MCP conectadas. Configura "mcpServers" en agente.config.json, o pasa un archivo .md / texto libre.');
  }
  const run = makeStageRunner(ctx);
  const r = await run({
    role: 'light',
    system: 'Eres un asistente que consulta un gestor de tareas mediante herramientas MCP. Responde siempre en el formato pedido.',
    tools: 'full',
    workdir: ctx.cwd,
    messages: [{ role: 'user', content: prompt }],
  });
  return extractJson(r.text);
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

async function startWork(ctx: Ctx, issue: Issue) {
  // "Aceptar las ediciones solas" elegido en el plan vale solo durante este flujo.
  const modeBefore = ctx.perms.mode;
  try {
    await runWork(ctx, issue);
  } finally {
    ctx.perms.mode = modeBefore;
  }
}

async function runWork(ctx: Ctx, issue: Issue) {
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
  if (result.status !== 'ready') {
    process.exitCode = result.status === 'failed' ? 1 : 0;
    return;
  }
  const now =
    values.ship ||
    (process.stdin.isTTY &&
      (
        await workflowIO(ctx).choose({
          title: 'Entrega',
          detail: [`Rama ${result.branch}`],
          approve: 'Sí, hacer commit, push y abrir el PR',
          cancel: 'No, lo entrego después (agente ship)',
        })
      ).kind === 'approve');
  if (now) await deliver(ctx, result as Required<Pick<typeof result, 'branch' | 'workdir' | 'base' | 'issue' | 'plan'>> & typeof result);
  else console.log(`Cuando quieras entregarlo: agente ship ${result.branch}`);
}

async function deliver(ctx: Ctx, r: { branch: string; workdir: string; base: string; issue: Issue; plan: string; verified?: boolean; runFile?: string }) {
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
    draft: values.draft,
    runStage,
    mcpToolNames: Object.keys(ctx.mcp.tools),
    createPr: makePrCreator({ method: ctx.config.workflow.pr.method, runStage, mcpToolNames: Object.keys(ctx.mcp.tools) }),
    io: workflowIO(ctx),
  });
  if (!res.pushed) process.exitCode = 1;
}

async function shipBranch(ctx: Ctx, branchArg?: string) {
  const root = ctx.root;
  if (!root) throw new Error('Este directorio no es un repositorio git.');
  const branch = branchArg ?? (await currentBranch(root));
  const found = await findRun(root, branch);
  if (!found) throw new Error(`No hay una ejecución de \`agente work\` registrada para la rama "${branch}".`);
  const { rec, file } = found;
  await deliver(ctx, { ...rec, workdir: existsSync(rec.workdir) ? rec.workdir : root, runFile: file });
}

async function work(ctx: Ctx, args: string[]) {
  const ref = args.join(' ').trim();
  if (!ref) throw new Error('Indica la tarea: agente work PROJ-123 | archivo.md | "texto libre"');
  await startWork(ctx, await resolveIssue(ctx, ref));
}

async function issues(ctx: Ctx) {
  if (!process.stdin.isTTY) throw new Error('`agente issues` es interactivo; usa `agente work <issue>` en scripts.');
  const root = ctx.root ?? ctx.cwd;
  const json = await askTracker(ctx, await loadPrompt(root, 'issue-list', { query: ctx.config.workflow.issueQuery }));
  const list = IssueListSchema.parse(json);
  if (!list.length) return console.log('No hay issues que coincidan.');
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
  if (choice === 'cancel') return;
  const chosen = list[choice];
  if (!chosen) return;
  await startWork(ctx, await resolveIssue(ctx, chosen.key ?? chosen.title));
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
