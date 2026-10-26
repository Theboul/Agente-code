import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { currentBranch, slugify } from '../src/git.js';
import { branchNameFor, classifyRef, extractJson, issueFromText } from '../src/workflow/issue.js';
import { renderTemplate, loadPrompt } from '../src/workflow/prompts.js';
import { runWorkflow, type StageRunner } from '../src/workflow/run.js';
import { detectSetupCommands, detectVerifyCommands } from '../src/workflow/verify.js';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function tempRepo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'wf-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@t.t');
  sh(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'README.md'), 'hola');
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('piezas del flujo', () => {
  it('slugify y nombres de rama', () => {
    expect(slugify('¡Arreglar el Login, ya!')).toBe('arreglar-el-login-ya');
    expect(branchNameFor({ key: 'PROJ-123', title: 'Añadir caché', body: '' }, 'feat/')).toBe('feat/proj-123-anadir-cache');
    expect(branchNameFor({ title: '***', body: '' }, 'fix/')).toBe('fix/');
  });
  it('clasifica referencias', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ref-'));
    writeFileSync(join(cwd, 'tarea.md'), '# T\ncuerpo');
    expect(classifyRef('PROJ-12', cwd).kind).toBe('tracker');
    expect(classifyRef('#45', cwd).kind).toBe('tracker');
    expect(classifyRef('https://x.atlassian.net/browse/A-1', cwd).kind).toBe('tracker');
    expect(classifyRef('tarea.md', cwd).kind).toBe('file');
    expect(classifyRef('arregla el login', cwd).kind).toBe('text');
    expect(classifyRef('noexiste.md', cwd).kind).toBe('text');
    expect(issueFromText('# Título\n\ncuerpo largo')).toMatchObject({ title: 'Título', body: 'cuerpo largo' });
  });
  it('extrae JSON de respuestas del modelo', () => {
    expect(extractJson('Aquí:\n```json\n{"a":1}\n```\nfin')).toEqual({ a: 1 });
    expect(extractJson('texto [{"k":"A-1"}] más')).toEqual([{ k: 'A-1' }]);
    expect(() => extractJson('nada')).toThrow();
  });
  it('detecta verificación y setup', () => {
    const d = mkdtempSync(join(tmpdir(), 'det-'));
    writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .', build: 'x' } }));
    writeFileSync(join(d, 'pnpm-lock.yaml'), '');
    expect(detectVerifyCommands(d)).toEqual(['pnpm run lint', 'pnpm run test']);
    expect(detectSetupCommands(d)).toEqual(['pnpm install --frozen-lockfile']);
    const e = mkdtempSync(join(tmpdir(), 'det-'));
    writeFileSync(join(e, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(detectVerifyCommands(e)).toEqual([]);
  });
  it('prompts: plantillas y sobrescritura por el desarrollador', async () => {
    expect(renderTemplate('a {{x}} {{ y.z }} {{nada}}', { x: '1', 'y.z': '2' })).toBe('a 1 2 ');
    const d = mkdtempSync(join(tmpdir(), 'pr-'));
    expect(await loadPrompt(d, 'plan', { 'issue.title': 'T' })).toContain('**T**');
    mkdirSync(join(d, '.agente', 'prompts'), { recursive: true });
    writeFileSync(join(d, '.agente', 'prompts', 'plan.md'), 'Mi plantilla: {{issue.title}}');
    expect(await loadPrompt(d, 'plan', { 'issue.title': 'T' })).toBe('Mi plantilla: T');
  });
});

describe('flujo completo (modelo simulado, repo git real)', () => {
  const checker = `const fs=require('fs');process.exit(fs.existsSync('feature.txt')&&fs.readFileSync('feature.txt','utf8')==='ok'?0:1)`;
  const repo = () =>
    tempRepo({ 'package.json': JSON.stringify({ scripts: { test: 'node check.js' } }), 'check.js': checker, '.gitignore': 'node_modules\n' });

  const scripted = (answers: string[]) => {
    const log: string[] = [];
    return { log, io: { say: (m: string) => log.push(m), ask: async () => answers.shift() ?? '' } };
  };

  it('plan → rama → implementa mal → corrige solo → revisión aceptada', async () => {
    const dir = repo();
    const config = await loadConfig(dir);
    const stages: string[] = [];
    let impl = 0;
    const runStage: StageRunner = async ({ role, workdir, messages }) => {
      stages.push(role);
      if (role === 'plan') return { text: 'PLAN: crear feature.txt', newMessages: [{ role: 'assistant', content: 'PLAN' }] };
      writeFileSync(join(workdir, 'feature.txt'), impl++ === 0 ? 'mal' : 'ok');
      expect(JSON.stringify(messages)).toContain(impl === 1 ? 'PLAN: crear feature.txt' : 'node check.js');
      return { text: 'hecho', newMessages: [{ role: 'assistant', content: 'hecho' }] };
    };
    const { io } = scripted(['a', 'a']);
    const res = await runWorkflow({ cwd: dir, config, runStage, io, issue: { key: 'PROJ-1', title: 'Crear feature', body: 'x' } });

    expect(res).toMatchObject({ status: 'ready', branch: 'feat/proj-1-crear-feature', base: 'main', verified: true });
    expect(stages).toEqual(['plan', 'implement', 'implement']);
    expect(await currentBranch(dir)).toBe('feat/proj-1-crear-feature');
    expect(readFileSync(join(dir, 'feature.txt'), 'utf8')).toBe('ok');
    expect(sh(dir, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(existsSync(res.runFile!)).toBe(true);
  });

  it('cancelar el plan no crea ramas', async () => {
    const dir = repo();
    const res = await runWorkflow({
      cwd: dir,
      config: await loadConfig(dir),
      runStage: async () => ({ text: 'plan', newMessages: [] }),
      io: scripted(['x']).io,
      issue: { title: 'Algo', body: '' },
    });
    expect(res.status).toBe('cancelled');
    expect(sh(dir, 'branch', '--list')).toBe('* main');
  });

  it('comentarios en el plan lo regeneran', async () => {
    const dir = repo();
    const seen: string[] = [];
    await runWorkflow({
      cwd: dir,
      config: await loadConfig(dir),
      noVerify: true,
      runStage: async ({ role, messages }) => {
        seen.push(`${role}:${messages.length}`);
        return { text: 'p', newMessages: [{ role: 'assistant', content: 'p' }] };
      },
      io: scripted(['usa otra librería', 'a', 'x']).io,
      issue: { title: 'Algo', body: '' },
    });
    expect(seen).toEqual(['plan:1', 'plan:3', 'implement:1']);
  });

  it('rechaza árbol sucio en modo rama y funciona en worktree', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'README.md'), 'sucio');
    const base = { cwd: dir, noVerify: true, yes: true, issue: { title: 'W', body: '' }, runStage: async () => ({ text: 'p', newMessages: [] }), io: scripted([]).io };
    await expect(runWorkflow({ ...base, config: await loadConfig(dir) })).rejects.toThrow(/sin confirmar/);

    const res = await runWorkflow({
      ...base,
      worktree: true,
      config: { ...(await loadConfig(dir)), workflow: { ...(await loadConfig(dir)).workflow, setup: [] } },
      runStage: async ({ role, workdir }) => {
        if (role === 'implement') writeFileSync(join(workdir, 'nuevo.txt'), 'n');
        return { text: 'p', newMessages: [] };
      },
    });
    expect(res.status).toBe('ready');
    expect(res.workdir).not.toBe(dir);
    expect(existsSync(join(res.workdir!, 'nuevo.txt'))).toBe(true);
    expect(existsSync(join(dir, 'nuevo.txt'))).toBe(false);
    expect(await currentBranch(dir)).toBe('main');
  });

  it('falla con claridad fuera de un repo git', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nogit-'));
    await expect(
      runWorkflow({ cwd: dir, config: await loadConfig(dir), issue: { title: 'x', body: '' }, runStage: async () => ({ text: '', newMessages: [] }), io: scripted([]).io }),
    ).rejects.toThrow(/repositorio git/);
  });
});
