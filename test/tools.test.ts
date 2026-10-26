import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { runTurn } from '../src/agent/loop.js';
import type { Permissions } from '../src/permissions.js';
import { askUserTool, htmlToText, isBlockedHost, webFetchTool } from '../src/tools/extra.js';
import { previewChange } from '../src/tools/guarded.js';
import { nativeTools, readOnlyTools } from '../src/tools/index.js';

const opts = { toolCallId: 't', messages: [] } as never;
const run = async (tools: Record<string, unknown>, name: string, input: unknown) =>
  (tools[name] as { execute: (i: unknown, o: never) => Promise<unknown> }).execute(input, opts);

function setup(answer = true, extra: Partial<Permissions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tl-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.js'), 'const a = 1;\nconst b = 2;\n');
  const asked: string[] = [];
  const perms: Permissions = {
    autoApprove: false,
    allowedCommands: ['git status', 'ls'],
    confirm: async (q) => (asked.push(q), answer),
    ...extra,
  };
  return { dir, asked, perms, tools: nativeTools(dir, perms) as Record<string, unknown> };
}

describe('herramientas de @openharness/core con nuestra seguridad', () => {
  it('lee y busca sin pedir confirmación', async () => {
    const { tools, asked } = setup();
    const read = (await run(tools, 'readFile', { filePath: 'src/a.js' })) as { content: string };
    expect(read.content).toContain('const a = 1;');
    const found = (await run(tools, 'grep', { pattern: 'const b', dirPath: '.', ignoreCase: false })) as { matchCount: number };
    expect(found.matchCount).toBe(1);
    const list = (await run(tools, 'listFiles', { dirPath: '.', recursive: true })) as { entries: { name: string }[] };
    expect(list.entries.map((e) => e.name)).toContain('src/a.js');
    expect(asked).toHaveLength(0);
  });

  it('no sale del proyecto', async () => {
    const { tools } = setup();
    await expect(run(tools, 'readFile', { filePath: '../fuera.txt' })).rejects.toThrow(/fuera del proyecto/);
    await expect(run(tools, 'readFile', { filePath: '/etc/passwd' })).rejects.toThrow(/fuera del proyecto/);
    await expect(run(tools, 'writeFile', { filePath: '../x', content: 'x' })).rejects.toThrow(/fuera del proyecto/);
  });

  it('escribir, editar y borrar piden confirmación con vista previa; si se deniega no se toca nada', async () => {
    const { dir, tools, asked } = setup(false);
    await expect(run(tools, 'writeFile', { filePath: 'nuevo.txt', content: 'hola' })).rejects.toThrow(/DENEGADO/);
    await expect(run(tools, 'editFile', { filePath: 'src/a.js', oldString: 'a = 1', newString: 'a = 9', replaceAll: false })).rejects.toThrow(/DENEGADO/);
    await expect(run(tools, 'deleteFile', { filePath: 'src/a.js', recursive: false })).rejects.toThrow(/DENEGADO/);
    expect(existsSync(join(dir, 'nuevo.txt'))).toBe(false);
    expect(readFileSync(join(dir, 'src/a.js'), 'utf8')).toContain('a = 1');
    expect(asked[0]).toContain('archivo nuevo');
    expect(asked[1]).toMatch(/- const a = 1;\n\+ const a = 9;/);
    expect(asked[2]).toContain('BORRAR src/a.js');
  });

  it('con aprobación: escribe, edita y borra', async () => {
    const { dir, tools } = setup(true);
    await run(tools, 'writeFile', { filePath: 'x/y.txt', content: 'hola' });
    expect(readFileSync(join(dir, 'x/y.txt'), 'utf8')).toBe('hola');
    await run(tools, 'editFile', { filePath: 'src/a.js', oldString: 'a = 1', newString: 'a = 9', replaceAll: false });
    expect(readFileSync(join(dir, 'src/a.js'), 'utf8')).toContain('a = 9');
    await run(tools, 'deleteFile', { filePath: 'x/y.txt', recursive: false });
    expect(existsSync(join(dir, 'x/y.txt'))).toBe(false);
  });

  it('editFile trata $ del código nuevo como texto literal y exige unicidad', async () => {
    const { dir, tools } = setup(true);
    writeFileSync(join(dir, 'p.js'), 'x = 1;\ny = 1;\n');
    await run(tools, 'editFile', { filePath: 'p.js', oldString: 'x = 1;', newString: 'x = `$&-$1-$$`;', replaceAll: false });
    expect(readFileSync(join(dir, 'p.js'), 'utf8')).toBe('x = `$&-$1-$$`;\ny = 1;\n');
    const amb = (await run(tools, 'editFile', { filePath: 'p.js', oldString: '1', newString: '2', replaceAll: false })) as { error?: string };
    expect(amb.error).toMatch(/aparece 2 veces|veces/);
    await run(tools, 'editFile', { filePath: 'p.js', oldString: 'y = 1', newString: 'y = 5', replaceAll: true });
    expect(readFileSync(join(dir, 'p.js'), 'utf8')).toContain('y = 5');
  });

  it('bash: lista blanca sin preguntar, resto pregunta, peligrosos bloqueados', async () => {
    const { tools, asked } = setup(false);
    const ok = (await run(tools, 'bash', { command: 'ls', timeout: 5000 })) as { exitCode: number; stdout: string };
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain('src');
    expect(asked).toHaveLength(0);
    const denied = (await run(tools, 'bash', { command: 'touch zz', timeout: 5000 })) as { exitCode: number; stderr: string };
    expect(denied).toMatchObject({ exitCode: 126 });
    expect(denied.stderr).toContain('DENEGADO');
    const blocked = (await run(tools, 'bash', { command: 'sudo ls', timeout: 5000 })) as { stderr: string };
    expect(blocked.stderr).toContain('política de seguridad');
    expect(asked).toHaveLength(1);
  });

  it('lista de tareas notifica cada actualización', async () => {
    const { perms } = setup();
    const seen: string[][] = [];
    const tools = nativeTools(process.cwd(), perms, { onTodos: (t) => seen.push(t.map((x) => `${x.status}:${x.content}`)) }) as Record<string, unknown>;
    await run(tools, 'todowrite', { todos: [{ content: 'paso 1', status: 'in_progress', priority: 'medium' }, { content: 'paso 2', status: 'pending', priority: 'medium' }] });
    expect(seen).toEqual([['in_progress:paso 1', 'pending:paso 2']]);
    const back = (await run(tools, 'todoread', {})) as { todos: unknown[] };
    expect(back.todos).toHaveLength(2);
  });

  it('el plan solo tiene herramientas de lectura', () => {
    const names = Object.keys(readOnlyTools(process.cwd(), setup().perms));
    expect(names).toEqual(expect.arrayContaining(['readFile', 'listFiles', 'grep']));
    for (const n of ['writeFile', 'editFile', 'deleteFile', 'bash']) expect(names).not.toContain(n);
  });

  it('previewChange resume lo que cambia', () => {
    expect(previewChange(undefined, 'a\nb')).toContain('archivo nuevo, 2 líneas');
    expect(previewChange('a\nb\nc', 'a\nX\nc')).toBe('desde la línea 2:\n- b\n+ X');
    expect(previewChange('a', 'a')).toBe('sin cambios');
  });
});

describe('ask_user y web_fetch', () => {
  it('ask_user devuelve la respuesta o una instrucción si no hay terminal', async () => {
    const withTty = askUserTool({ autoApprove: false, allowedCommands: [], confirm: async () => true, ask: async (q) => (q.includes('1) A') ? ' A ' : '?') });
    expect(await run({ t: withTty }, 't', { question: '¿cuál?', options: ['A', 'B'] })).toBe('A');
    const noTty = askUserTool({ autoApprove: false, allowedCommands: [], confirm: async () => true });
    expect(String(await run({ t: noTty }, 't', { question: '¿cuál?' }))).toContain('Decide con tu mejor criterio');
  });

  it('web_fetch bloquea redes internas, pide permiso una vez por dominio y convierte HTML', async () => {
    expect(['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.4', '172.20.0.1', '169.254.169.254', '[::1]', 'x.internal'].every(isBlockedHost)).toBe(true);
    expect(isBlockedHost('example.com') || isBlockedHost('8.8.8.8')).toBe(false);

    const asked: string[] = [];
    const perms: Permissions = { autoApprove: false, allowedCommands: [], confirm: async (q) => (asked.push(q), true) };
    let calls = 0;
    const fake = (async () => (calls++, new Response('<html><head><style>x{}</style></head><body><h1>Hola</h1><p>a &amp; b</p><script>mal()</script></body></html>', { headers: { 'content-type': 'text/html' } }))) as typeof fetch;
    const tool = webFetchTool(perms, fake);
    expect(await run({ t: tool }, 't', { url: 'http://localhost:3000/x' })).toMatchObject({ error: expect.stringContaining('bloqueado') });
    expect(await run({ t: tool }, 't', { url: 'file:///etc/passwd' })).toMatchObject({ error: expect.any(String) });
    const r = (await run({ t: tool }, 't', { url: 'https://docs.example.com/a' })) as { text: string };
    expect(r.text).toBe('Hola\na & b');
    await run({ t: tool }, 't', { url: 'https://docs.example.com/b' });
    expect(asked).toHaveLength(1);
    expect(calls).toBe(2);
    expect(htmlToText('<p>x</p><script>y</script>')).toBe('x');
  });
});

describe('compatibilidad: herramientas de la librería (SDK v6) dentro de nuestro bucle (SDK v7)', () => {
  it('el modelo llama a readFile y recibe el contenido', async () => {
    const { tools, dir } = setup();
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    let n = 0;
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        n++;
        const chunks =
          n === 1
            ? [
                { type: 'stream-start', warnings: [] },
                { type: 'tool-call', toolCallId: 'c1', toolName: 'readFile', input: JSON.stringify({ filePath: 'src/a.js' }) },
                { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool' }, usage },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 't' },
                { type: 'text-delta', id: 't', delta: JSON.stringify(prompt).includes('const b = 2;') ? 'vi el contenido' : 'no vi nada' },
                { type: 'text-end', id: 't' },
                { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
              ];
        return { stream: convertArrayToReadableStream(chunks as never) };
      },
    });
    const out: string[] = [];
    const r = await runTurn({ model, system: 's', tools: tools as never, messages: [{ role: 'user', content: 'lee' }], maxSteps: 4, onToolResult: (name) => out.push(name) });
    expect(out).toEqual(['readFile']);
    expect(r.text).toBe('vi el contenido');
    void dir;
  });
});
