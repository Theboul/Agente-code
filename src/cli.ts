#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import type { ModelMessage } from 'ai';
import { runTurn } from './agent/loop.js';
import { buildSystemPrompt } from './agent/system.js';
import { loadConfig, modelFor, ROLES, type Config, type Role } from './config.js';
import { currentBranch, repoRoot } from './git.js';
import { connectMcpServers, type McpConnections } from './mcp/client.js';
import type { Permissions } from './permissions.js';
import { missingKeyHint, resolveModel } from './providers.js';
import { nativeTools, readOnlyTools } from './tools/index.js';
import { classifyRef, extractJson, IssueListSchema, IssueSchema, issueFromFile, issueFromText, type Issue } from './workflow/issue.js';
import { DEFAULT_PROMPTS, loadPrompt } from './workflow/prompts.js';
import { makePrCreator } from './workflow/pr.js';
import { runWorkflow, type StageRunner } from './workflow/run.js';
import { findRun } from './workflow/runs.js';
import { ship } from './workflow/ship.js';
import { detectVerifyCommands } from './workflow/verify.js';

const HELP = `agente — arnés de código multi-modelo

Uso:
  agente [chat]                  Sesión interactiva en el directorio actual
  agente work <issue>            Flujo completo: plan → rama → implementación → verificación → revisión
                                 <issue> = PROJ-123 | #45 | URL (vía MCP), archivo .md/.txt, o texto libre
  agente ship [rama]             Commit → push → PR → sincroniza el tracker (tras "work")
  agente issues                  Lista issues del tracker (MCP), eliges una y sigue el flujo
  agente init                    Crea agente.config.json y .agente/prompts/ para personalizar

Opciones:
  -m, --model <prov/modelo>   Usa este modelo en todas las etapas (ej. google/gemini-flash-latest)
  -r, --role <rol>            (chat) modelo del rol: ${ROLES.join(' | ')}
  -p, --prompt <texto>        (chat) un solo turno y salir
      --base <rama>           (work) rama base; por defecto la actual
      --worktree              (work) trabajar en un worktree aislado en vez de una rama en el repo
      --no-verify             (work) omitir la verificación automática
      --ship                  (work/ship) entregar sin confirmaciones intermedias (commit, push y PR)
      --draft                 (ship) abrir el PR como borrador
  -y, --yes                   Aprobar planes, ediciones y comandos sin preguntar
  -h, --help

Dentro del chat: /model <prov/modelo>, /role <rol>, /mcp, /clear, /exit
Configuración: agente.config.json (ver README).`;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const short = (v: unknown, n = 160) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
};

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

async function main() {
  if (values.help) return console.log(HELP);
  const cmd = positionals[0] ?? 'chat';
  if (!['chat', 'work', 'ship', 'issues', 'init'].includes(cmd)) {
    console.error(`Comando desconocido: ${cmd}\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  if (cmd === 'init') return init(cwd);

  const config = await loadConfig(cwd);
  const root = (await repoRoot(cwd)) ?? cwd;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => {});

  const perms: Permissions = {
    autoApprove: values.yes ?? false,
    allowedCommands: [...config.allowedCommands, ...(config.workflow.verify ?? detectVerifyCommands(root))],
    confirm: async (q) => {
      if (!process.stdin.isTTY) return false;
      const a = await rl.question(`\n${q}\n[s/N] `);
      return /^(s|si|sí|y|yes)$/i.test(a.trim());
    },
  };
  const mcp = await connectMcpServers(config.mcpServers, perms);
  for (const s of mcp.status) if (!s.ok) console.log(`⚠ MCP ${s.name}: ${s.error}`);

  try {
    if (cmd === 'chat') await chat({ cwd, config, perms, mcp, rl });
    else if (cmd === 'work') await work({ cwd, root, config, perms, mcp, rl });
    else if (cmd === 'ship') await shipCmd({ cwd, root, config, perms, mcp, rl });
    else await issues({ cwd, root, config, perms, mcp, rl });
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
}

/** Un turno del agente con salida en vivo y Ctrl+C para interrumpir. */
function makeStageRunner({ config, perms, mcp }: Ctx): StageRunner {
  return async ({ role, system, tools, workdir, messages }) => {
    const modelId = values.model ?? modelFor(config, role);
    const hint = missingKeyHint(modelId, config);
    if (hint) throw new Error(`Falta la variable de entorno ${hint} para usar ${modelId}.`);
    console.log(dim(`\n[${role} · ${modelId}]`));
    // Sin herramientas = redacción de commit/PR: se muestra ya sanitizado por el flujo, no el texto crudo.
    const stream = tools !== 'none';
    const toolset =
      tools === 'none' ? {} : tools === 'readonly' ? readOnlyTools(workdir, perms) : tools === 'mcp' ? mcp.tools : { ...mcp.tools, ...nativeTools(workdir, perms) };
    const ac = new AbortController();
    const onSigint = () => ac.abort();
    process.once('SIGINT', onSigint);
    try {
      const r = await runTurn({
        model: resolveModel(modelId, config),
        system,
        tools: toolset,
        messages,
        maxSteps: config.maxSteps,
        abortSignal: ac.signal,
        onText: (d) => stream && process.stdout.write(d),
        onToolCall: (n, i) => console.log(dim(`\n⚙ ${n} ${short(i)}`)),
        onToolResult: (n, o) => console.log(dim(`  ↳ ${short(o, 200)}`)),
      });
      if (stream) console.log();
      return { text: r.text, newMessages: r.newMessages };
    } finally {
      process.off('SIGINT', onSigint);
    }
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
  return {
    say: (m: string) => console.log(m),
    ask: async (q: string) => {
      if (!process.stdin.isTTY) throw new Error('Se necesita una terminal interactiva para aprobar (o usa --yes / --ship).');
      return ctx.rl.question(q);
    },
  };
}

async function startWork(ctx: Ctx, issue: Issue) {
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
  const yes = /^(s|si|sí|y|yes)$/i;
  const now = values.ship || (process.stdin.isTTY && yes.test((await ctx.rl.question('\n¿Hacer commit, push y abrir el PR ahora? [s/N] ')).trim()));
  if (now) await deliver(ctx, result as Required<Pick<typeof result, 'branch' | 'workdir' | 'base' | 'issue' | 'plan'>> & typeof result);
  else console.log(`Cuando quieras entregarlo: agente ship ${result.branch}`);
}

async function deliver(
  ctx: Ctx,
  r: { branch: string; workdir: string; base: string; issue: Issue; plan: string; verified?: boolean; runFile?: string },
) {
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

async function shipCmd(ctx: Ctx) {
  const root = ctx.root;
  if (!root) throw new Error('Este directorio no es un repositorio git.');
  const branch = positionals[1] ?? (await currentBranch(root));
  const found = await findRun(root, branch);
  if (!found) throw new Error(`No hay una ejecución de \`agente work\` registrada para la rama "${branch}".`);
  const { rec, file } = found;
  await deliver(ctx, { ...rec, workdir: existsSync(rec.workdir) ? rec.workdir : root, runFile: file });
}

async function work(ctx: Ctx) {
  const ref = positionals.slice(1).join(' ').trim();
  if (!ref) throw new Error('Indica la tarea: agente work PROJ-123 | archivo.md | "texto libre"');
  await startWork(ctx, await resolveIssue(ctx, ref));
}

async function issues(ctx: Ctx) {
  if (!process.stdin.isTTY) throw new Error('`agente issues` es interactivo; usa `agente work <issue>` en scripts.');
  const root = ctx.root ?? ctx.cwd;
  const json = await askTracker(ctx, await loadPrompt(root, 'issue-list', { query: ctx.config.workflow.issueQuery }));
  const list = IssueListSchema.parse(json);
  if (!list.length) return console.log('No hay issues que coincidan.');
  list.forEach((i, n) => console.log(`${String(n + 1).padStart(2)}. ${i.key ?? '-'}  ${i.title}`));
  const pick = Number((await ctx.rl.question('\nNúmero de la issue (Enter para salir): ')).trim());
  const chosen = list[pick - 1];
  if (!chosen) return;
  await startWork(ctx, await resolveIssue(ctx, chosen.key ?? chosen.title));
}

async function chat(ctx: Ctx) {
  const { cwd, config, perms, mcp, rl } = ctx;
  let modelId = values.model ?? modelFor(config, (values.role as Role | undefined) ?? 'implement');
  const system = await buildSystemPrompt(cwd);
  const tools = { ...mcp.tools, ...nativeTools(cwd, perms) };
  let history: ModelMessage[] = [];

  const turn = async (input: string) => {
    const hint = missingKeyHint(modelId, config);
    if (hint) throw new Error(`Falta la variable de entorno ${hint} para usar ${modelId}.`);
    history.push({ role: 'user', content: input });
    const ac = new AbortController();
    const onSigint = () => ac.abort();
    process.once('SIGINT', onSigint);
    try {
      const { newMessages } = await runTurn({
        model: resolveModel(modelId, config),
        system,
        tools,
        messages: history,
        maxSteps: config.maxSteps,
        abortSignal: ac.signal,
        onText: (d) => process.stdout.write(d),
        onToolCall: (n, i) => console.log(dim(`\n⚙ ${n} ${short(i)}`)),
        onToolResult: (n, o) => console.log(dim(`  ↳ ${short(o, 200)}`)),
      });
      history.push(...newMessages);
      console.log();
    } catch (e) {
      history.pop();
      if (ac.signal.aborted) console.log(dim('\n(interrumpido)'));
      else console.error(`\nError: ${e instanceof Error ? e.message : e}`);
    } finally {
      process.off('SIGINT', onSigint);
    }
  };

  if (values.prompt !== undefined) return turn(values.prompt);

  const printMcp = () => {
    if (!mcp.status.length) return console.log(dim('Sin servidores MCP configurados (mcpServers en agente.config.json).'));
    for (const s of mcp.status) {
      console.log(s.ok ? `  ✓ ${s.name}: ${s.tools.length} herramientas` : `  ✗ ${s.name}: ${s.error}`);
      if (s.ok) for (const t of s.tools) console.log(dim(`      ${t}`));
    }
  };

  console.log(`agente · ${modelId} · ${cwd}\n${dim('/model, /role, /mcp, /clear, /exit')}`);
  if (mcp.status.some((s) => s.ok)) console.log(dim(`MCP: ${Object.keys(mcp.tools).length} herramientas (/mcp para ver)`));
  for (;;) {
    let line: string;
    try {
      line = (await rl.question('\n› ')).trim();
    } catch {
      break; // stdin cerrado
    }
    if (!line) continue;
    if (line === '/exit' || line === '/salir') break;
    if (line === '/clear') {
      history = [];
      console.log(dim('Historial limpiado.'));
    } else if (line === '/mcp') printMcp();
    else if (line.startsWith('/model ')) {
      modelId = line.slice(7).trim();
      console.log(dim(`Modelo: ${modelId}`));
    } else if (line.startsWith('/role ')) {
      const r = line.slice(6).trim() as Role;
      if (!ROLES.includes(r)) console.log(`Rol inválido. Opciones: ${ROLES.join(', ')}`);
      else {
        modelId = modelFor(config, r);
        console.log(dim(`Modelo (${r}): ${modelId}`));
      }
    } else await turn(line);
  }
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
        model: 'google/gemini-flash-latest',
        roles: { plan: 'google/gemini-flash-latest', implement: 'google/gemini-flash-latest' },
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
