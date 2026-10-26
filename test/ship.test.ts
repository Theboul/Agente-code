import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { compareUrl, parseRemote, pushBranch } from '../src/git.js';
import { hasMcpPrTool, makePrCreator, type PrCreator } from '../src/workflow/pr.js';
import { findRun, saveRun } from '../src/workflow/runs.js';
import type { StageRunner } from '../src/workflow/run.js';
import { hasAttribution, issueClosesLine, prTitle, sanitizeMessage, ship } from '../src/workflow/ship.js';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** Repo con remoto "origin" (bare), rama de trabajo con cambios sin confirmar. */
function setup() {
  const origin = mkdtempSync(join(tmpdir(), 'origin-'));
  sh(origin, 'init', '-q', '--bare', '-b', 'main');
  const dir = mkdtempSync(join(tmpdir(), 'ship-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'dev@example.com');
  sh(dir, 'config', 'user.name', 'Dev');
  writeFileSync(join(dir, 'a.txt'), 'a');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'init');
  sh(dir, 'remote', 'add', 'origin', origin);
  sh(dir, 'push', '-q', '-u', 'origin', 'main');
  sh(dir, 'checkout', '-q', '-b', 'feat/proj-1-algo');
  writeFileSync(join(dir, 'nuevo.txt'), 'n');
  return { dir, origin };
}

const scripted = (answers: string[] = []) => {
  const log: string[] = [];
  return { log, io: { say: (m: string) => void log.push(m), ask: async () => answers.shift() ?? 'a' } };
};

const MSG_CON_COAUTOR = 'feat: añade nuevo\n\nDetalle.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nClaude-Session: https://x/y';

function fakeStage(calls: { role: string; tools: string; prompt: string }[] = []): StageRunner {
  return async ({ role, tools, messages }) => {
    const prompt = String(messages[0]!.content);
    calls.push({ role, tools, prompt });
    if (prompt.includes('mensaje de commit')) return { text: MSG_CON_COAUTOR, newMessages: [] };
    if (prompt.includes('descripción (cuerpo)')) return { text: '## Resumen\nHace algo.\n\n🤖 Generated with Claude Code', newMessages: [] };
    return { text: 'Comenté en PROJ-1', newMessages: [] };
  };
}

const base = (dir: string) => ({
  root: dir,
  workdir: dir,
  issue: { key: 'PROJ-1', title: 'Algo', body: 'desc' },
  plan: 'el plan',
  base: 'main',
  branch: 'feat/proj-1-algo',
  mcpToolNames: ['mcp__jira__add_comment'],
});

describe('sanitizado y utilidades', () => {
  it('elimina coautoría y atribuciones', () => {
    const out = sanitizeMessage('```\nfeat: x\n\nCo-authored-by: A <a@b>\nClaude-Session: u\n🤖 Generated with Claude Code\n```');
    expect(out).toBe('feat: x');
    expect(hasAttribution(MSG_CON_COAUTOR)).toBe(true);
    expect(hasAttribution(out)).toBe(false);
    expect(sanitizeMessage('fix: y\n\nSigned-off-by: Dev <d@e>')).toContain('Signed-off-by');
  });
  it('remotos y enlaces de PR manual', () => {
    expect(parseRemote('git@github.com:o/r.git')).toEqual({ host: 'github.com', path: 'o/r' });
    expect(parseRemote('https://user@gitlab.com/g/s/r.git')).toEqual({ host: 'gitlab.com', path: 'g/s/r' });
    expect(compareUrl('git@github.com:o/r.git', 'main', 'feat/x')).toBe('https://github.com/o/r/compare/main...feat%2Fx?expand=1');
    expect(compareUrl('https://gitlab.com/o/r', 'main', 'f')).toContain('/-/merge_requests/new?');
    expect(compareUrl('/ruta/local', 'main', 'f')).toBeUndefined();
  });
  it('título y línea de cierre', () => {
    expect(prTitle({ key: 'PROJ-1', title: 'Algo', body: '' })).toBe('PROJ-1: Algo');
    expect(prTitle({ key: '#45', title: 'Algo', body: '' })).toBe('Algo');
    expect(issueClosesLine({ key: '#45', title: '', body: '' })).toBe('Closes #45');
    expect(issueClosesLine({ key: 'PROJ-1', title: '', body: '' })).toBe('Refs: PROJ-1');
    expect(hasMcpPrTool(['mcp__github__create_pull_request'])).toBe(true);
    expect(hasMcpPrTool(['mcp__jira__add_comment'])).toBe(false);
  });
  it('el push no reintenta errores que no son de red', async () => {
    const { dir } = setup();
    sh(dir, 'remote', 'set-url', 'origin', '/no/existe/repo.git');
    let sleeps = 0;
    await expect(pushBranch(dir, 'origin', 'feat/proj-1-algo', 4, async () => void sleeps++)).rejects.toThrow(/git push falló/);
    expect(sleeps).toBe(0);
  });
  it('elige el método de PR', async () => {
    const stage: StageRunner = async () => ({ text: '', newMessages: [] });
    const dir = mkdtempSync(join(tmpdir(), 'pr-'));
    sh(dir, 'init', '-q');
    const req = { root: dir, workdir: dir, remoteUrl: 'git@github.com:o/r.git', base: 'main', branch: 'f/x', title: 't', body: 'b', draft: false };
    const manual = await makePrCreator({ method: 'auto', runStage: stage, mcpToolNames: [], ghReady: async () => false })(req);
    expect(manual.method).toBe('manual');
    expect(manual.manualUrl).toContain('github.com/o/r/compare');
    const viaMcp = await makePrCreator({
      method: 'auto',
      mcpToolNames: ['mcp__github__create_pull_request'],
      ghReady: async () => false,
      runStage: async ({ tools }) => ({ text: tools === 'mcp' ? '```json\n{"url":"https://github.com/o/r/pull/9"}\n```' : '', newMessages: [] }),
    })(req);
    expect(viaMcp).toMatchObject({ method: 'mcp', url: 'https://github.com/o/r/pull/9' });
  });
});

describe('entrega: commit → push → PR → tracker', () => {
  it('flujo completo sin coautores en ninguna parte', async () => {
    const { dir, origin } = setup();
    writeFileSync(join(dir, '.env'), 'SECRETO=1');
    const calls: { role: string; tools: string; prompt: string }[] = [];
    const prs: Parameters<PrCreator>[0][] = [];
    const config = await loadConfig(dir);
    const { io, log } = scripted();
    const res = await ship({
      ...base(dir),
      config: { ...config, workflow: { ...config.workflow, syncStatus: 'In Review' } },
      io,
      runStage: fakeStage(calls),
      createPr: async (req) => (prs.push(req), { method: 'gh', url: 'https://github.com/o/r/pull/7' }),
    });

    expect(res).toMatchObject({ pushed: true, prUrl: 'https://github.com/o/r/pull/7', synced: true });
    // commit limpio y sin el secreto
    const msg = sh(dir, 'log', '-1', '--format=%B');
    expect(msg).toContain('feat: añade nuevo');
    expect(hasAttribution(msg)).toBe(false);
    expect(sh(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n')).toEqual(['nuevo.txt']);
    expect(log.join('\n')).toContain('.env');
    // push real al remoto
    expect(sh(origin, 'rev-parse', 'feat/proj-1-algo')).toBe(sh(dir, 'rev-parse', 'HEAD'));
    expect(sh(dir, 'log', '-1', '--format=%an <%ae>')).toBe('Dev <dev@example.com>');
    // PR
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ base: 'main', branch: 'feat/proj-1-algo', title: 'PROJ-1: Algo' });
    expect(hasAttribution(prs[0]!.body)).toBe(false);
    expect(prs[0]!.body).toContain('## Resumen');
    // sincronización: solo herramientas MCP, con el enlace y el estado
    const sync = calls.find((c) => c.prompt.includes('Sincroniza'))!;
    expect(sync.tools).toBe('mcp');
    expect(sync.prompt).toContain('https://github.com/o/r/pull/7');
    expect(sync.prompt).toContain('In Review');
    // el modelo nunca ve el contenido de archivos sensibles
    expect(calls.every((c) => !c.prompt.includes('SECRETO'))).toBe(true);
  });

  it('corrige coautoría añadida por un hook de git', async () => {
    const { dir } = setup();
    const hook = join(dir, '.git', 'hooks', 'prepare-commit-msg');
    writeFileSync(hook, '#!/bin/sh\nprintf "\\nCo-authored-by: Bot <bot@x>\\n" >> "$1"\n');
    chmodSync(hook, 0o755);
    await ship({
      ...base(dir),
      config: await loadConfig(dir),
      io: scripted().io,
      runStage: fakeStage(),
      createPr: async () => ({ method: 'manual', manualUrl: 'https://x' }),
    });
    expect(hasAttribution(sh(dir, 'log', '-1', '--format=%B'))).toBe(false);
  });

  it('rechaza ramas protegidas y ramas equivocadas; no sincroniza sin issue de tracker', async () => {
    const { dir } = setup();
    const common = { config: await loadConfig(dir), io: scripted().io, runStage: fakeStage(), createPr: async () => ({ method: 'manual' as const }) };
    await expect(ship({ ...base(dir), ...common, branch: 'main' })).rejects.toThrow(/protegida/);
    await expect(ship({ ...base(dir), ...common, branch: 'feat/otra' })).rejects.toThrow(/Estás en/);

    const calls: { role: string; tools: string; prompt: string }[] = [];
    const res = await ship({
      ...base(dir),
      ...common,
      runStage: fakeStage(calls),
      issue: { title: 'Texto libre', body: '' },
      createPr: async () => ({ method: 'gh', url: 'https://github.com/o/r/pull/1' }),
    });
    expect(res.synced).toBeUndefined();
    expect(calls.some((c) => c.tools === 'mcp')).toBe(false);
  });

  it('cancelar el mensaje no hace commit; "parar" tras el commit no hace push', async () => {
    const { dir, origin } = setup();
    const common = { ...base(dir), config: await loadConfig(dir), runStage: fakeStage(), createPr: async () => ({ method: 'manual' as const }) };
    const none = await ship({ ...common, io: scripted(['x']).io });
    expect(none.commit).toBeUndefined();
    expect(sh(dir, 'rev-list', '--count', 'HEAD')).toBe('1');

    const local = await ship({ ...common, io: scripted(['a', 'x']).io });
    expect(local).toMatchObject({ pushed: false });
    expect(local.commit).toBeTruthy();
    expect(sh(origin, 'branch', '--list')).not.toContain('feat/proj-1-algo');
  });

  it('registra la entrega en la ejecución guardada', async () => {
    const { dir } = setup();
    const runFile = await saveRun(dir, { status: 'ready', branch: 'feat/proj-1-algo', workdir: dir, base: 'main', issue: base(dir).issue, plan: 'p' });
    await ship({
      ...base(dir),
      runFile,
      config: await loadConfig(dir),
      io: scripted().io,
      runStage: fakeStage(),
      createPr: async () => ({ method: 'gh', url: 'https://github.com/o/r/pull/3' }),
    });
    const found = await findRun(dir, 'feat/proj-1-algo');
    expect(found?.rec.shipped).toMatchObject({ pushed: true, prUrl: 'https://github.com/o/r/pull/3' });
    expect(await findRun(dir, 'otra')).toBeUndefined();
  });
});
