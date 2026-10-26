import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, modelFor } from '../src/config.js';
import { classifyCommand } from '../src/permissions.js';
import { parseModelId, resolveModel } from '../src/providers.js';
import { safePath } from '../src/tools/guarded.js';
import { runCommand } from '../src/tools/bash.js';

const allowed = ['git status', 'npm test', 'ls'];

describe('permisos de comandos', () => {
  it('permite prefijos de la lista blanca', () => {
    expect(classifyCommand('git status', allowed)).toBe('allow');
    expect(classifyCommand('npm test -- foo', allowed)).toBe('allow');
  });
  it('pregunta por comandos desconocidos o encadenados', () => {
    expect(classifyCommand('rm file', allowed)).toBe('ask');
    expect(classifyCommand('ls; rm -rf x', allowed)).toBe('ask');
    expect(classifyCommand('ls $(whoami)', allowed)).toBe('ask');
  });
  it('bloquea force push y sudo', () => {
    expect(classifyCommand('git push --force origin main', allowed)).toBe('deny');
    expect(classifyCommand('sudo ls', allowed)).toBe('deny');
  });
});

describe('rutas', () => {
  it('rechaza rutas fuera del proyecto', () => {
    expect(() => safePath('/tmp/p', '../x')).toThrow();
    expect(() => safePath('/tmp/p', '/etc/passwd')).toThrow();
    expect(safePath('/tmp/p', 'src/a.ts')).toBe('/tmp/p/src/a.ts');
  });
});

describe('config y proveedores', () => {
  it('usa defaults y roles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ag-'));
    await writeFile(join(dir, 'agente.config.json'), JSON.stringify({ model: 'google/x', roles: { plan: 'anthropic/y' } }));
    const cfg = await loadConfig(dir);
    expect(modelFor(cfg, 'plan')).toBe('anthropic/y');
    expect(modelFor(cfg, 'implement')).toBe('google/x');
    expect((await loadConfig(await mkdtemp(join(tmpdir(), 'ag-')))).maxSteps).toBe(40);
  });
  it('parsea ids de modelo', async () => {
    expect(parseModelId('ollama/qwen2.5-coder:7b')).toEqual({ provider: 'ollama', model: 'qwen2.5-coder:7b' });
    expect(() => parseModelId('solo')).toThrow();
    const cfg = await loadConfig(await mkdtemp(join(tmpdir(), 'ag-')));
    for (const id of ['google/m', 'anthropic/m', 'openai/m', 'ollama/m']) expect(resolveModel(id, cfg)).toBeTruthy();
    expect(() => resolveModel('nada/m', cfg)).toThrow(/desconocido/);
  });
});

describe('bash', () => {
  it('captura salida y código', async () => {
    const out = await runCommand(process.cwd(), 'echo hola; exit 3', 5000);
    expect(out).toContain('hola');
    expect(out).toContain('[exit 3]');
  });
  it('mata por timeout', async () => {
    expect(await runCommand(process.cwd(), 'sleep 5', 200)).toContain('señal SIGKILL');
  });
});
