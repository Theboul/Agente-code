import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { Config } from '../config.js';
import { agentDir, git, gitOk, pushBranch, remoteUrl } from '../git.js';
import type { Issue } from './issue.js';
import type { PrCreator } from './pr.js';
import { loadPrompt } from './prompts.js';
import { decide, type StageRunner, type WorkflowIO } from './run.js';
import { updateRun } from './runs.js';

export interface ShipOptions {
  root: string;
  workdir: string;
  config: Config;
  issue: Issue;
  plan: string;
  base: string;
  branch: string;
  verified?: boolean;
  io: WorkflowIO;
  runStage: StageRunner;
  createPr: PrCreator;
  mcpToolNames: string[];
  /** Sin confirmaciones intermedias (--ship). */
  auto?: boolean;
  draft?: boolean;
  runFile?: string;
  sleep?: (ms: number) => Promise<void>;
}

export interface ShipResult {
  commit?: string;
  pushed: boolean;
  prUrl?: string;
  synced?: boolean;
}

/** Líneas de atribución/coautoría que nunca deben llegar a un commit, un PR ni un comentario. */
const ATTRIBUTION = /^\s*(co-authored-by:|claude-session:|generated (with|by)\b|🤖).*$/gim;

/** Quita bloques de código envolventes y toda atribución; recorta espacios. */
export function sanitizeMessage(text: string): string {
  return text
    .replace(/^```[\w-]*\n([\s\S]*?)\n```\s*$/m, '$1')
    .replace(ATTRIBUTION, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const hasAttribution = (text: string): boolean => new RegExp(ATTRIBUTION.source, 'im').test(text);

const SENSITIVE = /(^|\/)(\.env(\..+)?|id_rsa[^/]*|id_ed25519[^/]*|[^/]+\.(pem|key|p12|pfx))$/i;
const MAX_DIFF_CHARS = 12_000;

export function issueClosesLine(issue: Issue): string {
  return issue.key && /^#\d+$/.test(issue.key) ? `Closes ${issue.key}` : issue.key ? `Refs: ${issue.key}` : '';
}

export const prTitle = (issue: Issue): string => (issue.key && !/^#/.test(issue.key) ? `${issue.key}: ${issue.title}` : issue.title);

export async function ship(o: ShipOptions): Promise<ShipResult> {
  const { io, config, issue, workdir, branch, base } = o;
  const wf = config.workflow;
  const result: ShipResult = { pushed: false };

  // ── Guardas (antes de tocar nada) ───────────────────────────────────────────
  if (branch === base || wf.protectedBranches.includes(branch)) {
    throw new Error(`No se hace commit/push desde la rama protegida "${branch}". Usa la rama creada por \`agente work\`.`);
  }
  const current = await gitOk(workdir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current !== branch) throw new Error(`Estás en "${current}" pero la tarea está en "${branch}". Cámbiate a esa rama (o a su worktree: ${workdir}).`);
  const url = await remoteUrl(workdir, wf.remote);
  if (!url) throw new Error(`No existe el remoto "${wf.remote}". Añádelo con: git remote add ${wf.remote} <url>`);
  for (const key of ['user.name', 'user.email']) {
    if (!(await gitOk(workdir, ['config', '--get', key]).catch(() => ''))) {
      throw new Error(`Falta git config ${key}. Configúralo: git config ${key} "<valor>"`);
    }
  }

  const ask = (q: string) => decide(io, q, o.auto);
  const verifyText = o.verified === undefined ? 'no registrada' : o.verified ? 'lint/typecheck/tests correctos' : 'con fallos pendientes';
  const ctx = {
    'issue.key': issue.key ?? '',
    'issue.title': issue.title,
    'issue.body': issue.body,
    'issue.closes': issueClosesLine(issue),
    plan: o.plan,
    branch,
    verify: verifyText,
  };

  // ── 1. COMMIT ───────────────────────────────────────────────────────────────
  io.say('\n━━ Entrega 1/4 · Commit ━━');
  const dirty = (await gitOk(workdir, ['status', '--porcelain'])) !== '';
  if (dirty) {
    await gitOk(workdir, ['add', '-A']);
    const staged = (await gitOk(workdir, ['diff', '--cached', '--name-only'])).split('\n').filter(Boolean);
    const skipped = staged.filter((f) => SENSITIVE.test(f));
    if (skipped.length) {
      await gitOk(workdir, ['reset', '-q', '--', ...skipped]);
      io.say(`⚠ No se incluyen archivos que parecen secretos: ${skipped.join(', ')}`);
    }
    // Solo lo preparado (--cached): así nada excluido por sensible llega al modelo.
    const stat = await gitOk(workdir, ['diff', '--cached', '--stat']);
    const patch = await gitOk(workdir, ['diff', '--cached']);
    if (!stat) throw new Error('No hay nada para confirmar (solo había archivos sensibles).');

    let feedback = '';
    let message = '';
    for (;;) {
      const r = await o.runStage({
        role: 'light',
        system: 'Redactas mensajes de commit claros en español.',
        tools: 'none',
        workdir,
        messages: [
          {
            role: 'user',
            content: await loadPrompt(o.root, 'commit', {
              ...ctx,
              'diff.stat': stat,
              diff: patch.length > MAX_DIFF_CHARS ? patch.slice(0, MAX_DIFF_CHARS) + '\n…[diff recortado]' : patch,
              feedback,
            }),
          },
        ],
      });
      message = sanitizeMessage(r.text);
      if (!message) throw new Error('El modelo no generó un mensaje de commit.');
      io.say(`\nMensaje de commit:\n${message.split('\n').map((l) => `  │ ${l}`).join('\n')}`);
      const reply = await ask('\n¿Confirmar con este mensaje?  [a]probar · [x] cancelar · o escribe cómo cambiarlo: ');
      if (reply.kind === 'approve') break;
      if (reply.kind === 'cancel') {
        io.say('Cancelado. Los cambios quedan en el área de preparación (git reset para deshacer).');
        return result;
      }
      feedback = `\n\nAjuste pedido por el usuario sobre un mensaje anterior: ${reply.text}`;
    }

    const dir = join(await agentDir(o.root), 'tmp');
    await mkdir(dir, { recursive: true });
    const msgFile = join(dir, 'COMMIT_MSG');
    await writeFile(msgFile, message + '\n');
    const c = await git(workdir, ['commit', '-q', '-F', msgFile]);
    if (c.code !== 0) throw new Error(`git commit falló (¿un hook?):\n${(c.stderr || c.stdout).trim()}`);
    // Un hook (prepare-commit-msg…) podría añadir coautoría: se corrige en el commit local, antes del push.
    const written = await gitOk(workdir, ['log', '-1', '--format=%B']);
    // El amend se hace sin hooks (core.hooksPath vacío), si no el mismo hook volvería a añadirla.
    if (hasAttribution(written)) await gitOk(workdir, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--amend', '-F', msgFile]);
  } else if ((await gitOk(workdir, ['rev-list', '--count', `${base}..HEAD`]).catch(() => '0')) === '0') {
    throw new Error('No hay cambios que confirmar ni commits nuevos respecto a la base.');
  } else {
    io.say('El árbol está limpio; se usarán los commits ya existentes en la rama.');
  }
  result.commit = await gitOk(workdir, ['rev-parse', '--short', 'HEAD']);
  io.say(`✓ Commit ${result.commit}`);

  // ── 2. PUSH ─────────────────────────────────────────────────────────────────
  io.say('\n━━ Entrega 2/4 · Push ━━');
  const go = await ask(`\n¿Subir la rama ${branch} a ${wf.remote}?  [a]sí · [x] parar aquí: `);
  if (go.kind !== 'approve') {
    io.say(`Quedó el commit local. Súbelo después con: agente ship (o git push -u ${wf.remote} ${branch})`);
    await record(o, result);
    return result;
  }
  await pushBranch(workdir, wf.remote, branch, wf.pushRetries, o.sleep);
  result.pushed = true;
  io.say(`✓ Subido a ${wf.remote}/${branch}`);

  // ── 3. PULL REQUEST ─────────────────────────────────────────────────────────
  io.say('\n━━ Entrega 3/4 · Pull request ━━');
  const stat = await gitOk(workdir, ['diff', '--stat', `${base}...HEAD`]).catch(() => '');
  const template = [join(workdir, '.github', 'pull_request_template.md'), join(workdir, 'pull_request_template.md')].find(existsSync);
  const bodyReply = await o.runStage({
    role: 'light',
    system: 'Redactas descripciones de pull request claras en español.',
    tools: 'none',
    workdir,
    messages: [
      {
        role: 'user',
        content: await loadPrompt(o.root, 'pr', {
          ...ctx,
          'diff.stat': stat,
          template: template ? `\nUsa esta plantilla del repositorio, respetando sus secciones:\n${readFileSync(template, 'utf8')}\n` : '',
        }),
      },
    ],
  });
  const body = sanitizeMessage(bodyReply.text);
  // Con clave de tracker: "PROJ-1: título". Sin clave (texto libre) el título de la tarea puede ser un párrafo: se usa el asunto del commit.
  const title = issue.key ? prTitle(issue) : await gitOk(workdir, ['log', '-1', '--format=%s']);
  io.say(`\nTítulo: ${title}\n\n${body}`);
  const prGo = await ask(`\n¿Abrir el PR contra ${base}?  [a]sí · [x] omitir: `);
  if (prGo.kind !== 'approve') {
    io.say('PR omitido. La rama ya está subida.');
    await record(o, result);
    return result;
  }
  const pr = await o.createPr({ root: o.root, workdir, remoteUrl: url, base, branch, title, body, draft: o.draft ?? wf.pr.draft });
  if (pr.url) {
    result.prUrl = pr.url;
    io.say(`✓ PR (${pr.method}): ${pr.url}`);
  } else {
    io.say(`No se pudo crear el PR automáticamente (no hay gh autenticado ni herramienta MCP).\n  Ábrelo aquí: ${pr.manualUrl ?? '(no se reconoce el remoto)'}\n  Descripción lista en: ${pr.bodyFile}`);
  }

  // ── 4. SINCRONIZAR CON EL TRACKER ───────────────────────────────────────────
  if (result.prUrl && issue.key && wf.sync && o.mcpToolNames.length) {
    io.say('\n━━ Entrega 4/4 · Tracker ━━');
    try {
      const r = await o.runStage({
        role: 'light',
        system: 'Actualizas un gestor de tareas con herramientas MCP. Sé breve.',
        tools: 'mcp',
        workdir,
        messages: [
          {
            role: 'user',
            content: await loadPrompt(o.root, 'sync', {
              ...ctx,
              'pr.url': result.prUrl,
              'sync.status': wf.syncStatus ? `Mueve la issue al estado "${wf.syncStatus}" (busca la transición equivalente).` : 'No cambies el estado de la issue.',
            }),
          },
        ],
      });
      result.synced = true;
      io.say(`✓ Tracker: ${sanitizeMessage(r.text).split('\n')[0]}`);
    } catch (e) {
      io.say(`⚠ El PR está creado, pero no se pudo actualizar el tracker: ${e instanceof Error ? e.message : e}`);
    }
  }

  await record(o, result);
  return result;
}

async function record(o: ShipOptions, r: ShipResult) {
  if (o.runFile) await updateRun(o.runFile, { shipped: { commit: r.commit, pushed: r.pushed, prUrl: r.prUrl, at: new Date().toISOString() } });
}
