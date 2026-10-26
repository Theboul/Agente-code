import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ModelMessage } from 'ai';
import { buildSystemPrompt } from '../agent/system.js';
import type { Config, Role } from '../config.js';
import {
  addWorktree,
  agentDir,
  branchExists,
  createBranch,
  currentBranch,
  defaultWorktreeDir,
  fullDiff,
  hasCommits,
  isClean,
  repoRoot,
} from '../git.js';
import { execCommand } from '../tools/bash.js';
import { branchNameFor, type Issue } from './issue.js';
import { loadPrompt } from './prompts.js';
import { detectSetupCommands, detectVerifyCommands, runVerify } from './verify.js';

export type ToolScope = 'readonly' | 'full';

/** Ejecuta un turno del agente. Lo implementa la CLI (modelos reales) o los tests (simulado). */
export type StageRunner = (a: {
  role: Role;
  system: string;
  tools: ToolScope;
  workdir: string;
  messages: ModelMessage[];
}) => Promise<{ text: string; newMessages: ModelMessage[] }>;

export interface WorkflowIO {
  ask(question: string): Promise<string>;
  say(message: string): void;
}

export interface WorkflowOptions {
  cwd: string;
  config: Config;
  issue: Issue;
  io: WorkflowIO;
  runStage: StageRunner;
  /** Rama base; por defecto la actual. */
  base?: string;
  /** Fuerza worktree aunque la config diga "branch". */
  worktree?: boolean;
  /** Aprobar plan y revisión sin preguntar. */
  yes?: boolean;
  noVerify?: boolean;
}

export type WorkflowStatus = 'ready' | 'cancelled' | 'failed';

export interface WorkflowResult {
  status: WorkflowStatus;
  branch?: string;
  workdir?: string;
  base?: string;
  verified?: boolean;
  runFile?: string;
}

const APPROVE = /^(a|s|si|sí|y|yes|ok)$/i;
const CANCEL = /^(x|n|no|cancelar|salir)$/i;
const MAX_DIFF_LINES = 400;

type Reply = { kind: 'approve' } | { kind: 'cancel' } | { kind: 'feedback'; text: string };

async function decide(io: WorkflowIO, question: string, yes?: boolean): Promise<Reply> {
  if (yes) return { kind: 'approve' };
  const a = (await io.ask(question)).trim();
  if (APPROVE.test(a)) return { kind: 'approve' };
  if (!a || CANCEL.test(a)) return { kind: 'cancel' };
  return { kind: 'feedback', text: a };
}

export async function runWorkflow(o: WorkflowOptions): Promise<WorkflowResult> {
  const { io, issue, config } = o;
  const wf = config.workflow;

  const root = await repoRoot(o.cwd);
  if (!root) throw new Error('Este directorio no es un repositorio git. Ejecuta `git init` primero.');
  if (!(await hasCommits(root))) throw new Error('El repositorio no tiene commits todavía. Crea al menos uno antes de usar el flujo.');
  const base = o.base ?? (await currentBranch(root));
  if (base === 'HEAD') throw new Error('Estás en HEAD desacoplado. Cámbiate a una rama o indica una con --base <rama>.');
  const useWorktree = o.worktree ?? wf.isolation === 'worktree';
  if (!useWorktree && !(await isClean(root))) {
    throw new Error('Hay cambios sin confirmar en el árbol de trabajo. Haz commit o stash antes, o usa --worktree para trabajar en una copia aislada.');
  }

  const ctx = { 'issue.key': issue.key ?? '', 'issue.title': issue.title, 'issue.body': issue.body };
  const label = issue.key ? `${issue.key} · ${issue.title}` : issue.title;
  io.say(`\n▶ ${label}\n  base: ${base} · aislamiento: ${useWorktree ? 'worktree' : 'rama'}`);

  // ── 1. PLAN (solo lectura, antes de crear nada) ─────────────────────────────
  io.say('\n━━ 1/4 Plan ━━');
  const system = await buildSystemPrompt(root);
  const planMessages: ModelMessage[] = [{ role: 'user', content: await loadPrompt(root, 'plan', ctx) }];
  let plan = '';
  for (;;) {
    const r = await o.runStage({ role: 'plan', system, tools: 'readonly', workdir: root, messages: planMessages });
    plan = r.text.trim();
    planMessages.push(...r.newMessages);
    const reply = await decide(io, '\n¿Aprobar el plan?  [a]probar · [x] cancelar · o escribe qué cambiar: ', o.yes);
    if (reply.kind === 'approve') break;
    if (reply.kind === 'cancel') {
      io.say('Cancelado. No se creó ninguna rama.');
      return { status: 'cancelled' };
    }
    planMessages.push({ role: 'user', content: `Ajusta el plan: ${reply.text}` });
  }

  // ── 2. RAMA / WORKTREE ──────────────────────────────────────────────────────
  io.say('\n━━ 2/4 Rama ━━');
  let branch = branchNameFor(issue, wf.branchPrefix);
  for (let n = 2; await branchExists(root, branch); n++) branch = `${branchNameFor(issue, wf.branchPrefix)}-${n}`;

  let workdir = root;
  if (useWorktree) {
    const dir = wf.worktreeDir ? resolve(root, wf.worktreeDir) : defaultWorktreeDir(root);
    workdir = join(dir, branch.replace(/\//g, '-'));
    await addWorktree(root, workdir, branch, base);
    io.say(`Worktree: ${workdir}`);
    for (const cmd of wf.setup ?? detectSetupCommands(workdir)) {
      io.say(`$ ${cmd}`);
      const r = await execCommand(workdir, cmd, 600_000);
      if (r.code !== 0) throw new Error(`Falló la preparación del worktree (${cmd}):\n${r.output.slice(-2000)}`);
    }
  } else {
    await createBranch(root, branch, base);
  }
  io.say(`Rama: ${branch}`);

  // ── 3. IMPLEMENTAR + VERIFICAR ──────────────────────────────────────────────
  const verifyCommands = o.noVerify ? [] : (wf.verify ?? detectVerifyCommands(workdir));
  io.say(verifyCommands.length ? `Verificación: ${verifyCommands.join(' → ')}` : 'Verificación: ninguna (define workflow.verify en la config).');

  const implSystem = await buildSystemPrompt(workdir);
  const history: ModelMessage[] = [
    { role: 'user', content: await loadPrompt(root, 'implement', { ...ctx, plan, branch }) },
  ];
  const step = async () => {
    const r = await o.runStage({ role: 'implement', system: implSystem, tools: 'full', workdir, messages: history });
    history.push(...r.newMessages);
  };

  const verifyLoop = async (): Promise<boolean> => {
    for (let attempt = 0; ; attempt++) {
      if (!verifyCommands.length) return true;
      io.say('\n▸ Verificando…');
      const report = await runVerify(workdir, verifyCommands);
      if (report.ok) {
        io.say(`✓ Verificación correcta (${report.passed.length} comandos)`);
        return true;
      }
      const f = report.failure!;
      io.say(`✗ Falló: ${f.command}`);
      if (attempt >= wf.maxFixAttempts) return false;
      io.say(`  Corrigiendo (intento ${attempt + 1}/${wf.maxFixAttempts})…`);
      history.push({ role: 'user', content: await loadPrompt(root, 'fix', { ...ctx, 'verify.command': f.command, 'verify.output': f.output }) });
      await step();
    }
  };

  io.say('\n━━ 3/4 Implementación ━━');
  await step();
  let verified = await verifyLoop();
  if (!verified) {
    const go = await decide(io, '\nLa verificación sigue fallando. ¿Pasar a la revisión de todos modos?  [a]sí · [x] cancelar: ', o.yes);
    if (go.kind !== 'approve') {
      io.say(`Detenido. El trabajo queda en la rama ${branch}${useWorktree ? ` (${workdir})` : ''}.`);
      return await finish('failed');
    }
  }

  // ── 4. REVISIÓN ─────────────────────────────────────────────────────────────
  io.say('\n━━ 4/4 Revisión ━━');
  for (;;) {
    const { stat, patch } = await fullDiff(workdir);
    if (!stat) io.say('(sin cambios en el árbol de trabajo)');
    else {
      const lines = patch.split('\n');
      io.say(`\n${stat}\n`);
      io.say(lines.slice(0, MAX_DIFF_LINES).join('\n'));
      if (lines.length > MAX_DIFF_LINES) io.say(`…[${lines.length - MAX_DIFF_LINES} líneas más; usa \`git diff\` en ${workdir}]`);
    }
    const reply = await decide(io, '\n¿Aceptar los cambios?  [a]ceptar · [x] descartar · o escribe qué cambiar: ', o.yes);
    if (reply.kind === 'approve') break;
    if (reply.kind === 'cancel') {
      const cleanup = useWorktree
        ? `git worktree remove --force "${workdir}" && git branch -D ${branch}`
        : `git checkout ${base} && git branch -D ${branch}   (antes: git checkout -- . para descartar cambios)`;
      io.say(`Descartado. Para limpiar:\n  ${cleanup}`);
      return await finish('cancelled');
    }
    history.push({ role: 'user', content: `Cambios solicitados en la revisión: ${reply.text}` });
    await step();
    verified = await verifyLoop();
  }

  io.say(`\n✓ Listo en la rama ${branch}${useWorktree ? ` (${workdir})` : ''}. Los cambios no están confirmados (sin commit).`);
  return await finish('ready');

  async function finish(status: WorkflowStatus): Promise<WorkflowResult> {
    const dir = join(await agentDir(root!), 'runs');
    await mkdir(dir, { recursive: true });
    const runFile = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${branch.replace(/\//g, '-')}.json`);
    const result: WorkflowResult = { status, branch, workdir, base, verified, runFile };
    await writeFile(runFile, JSON.stringify({ ...result, issue, plan }, null, 2));
    return result;
  }
}
