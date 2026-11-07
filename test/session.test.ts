import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { runChat } from '../src/chat.js';
import { loadConfig } from '../src/config.js';
import { listSessions, loadSession, newSessionId, pruneSessions, type SessionRecord, saveSession, sessionsDir, sessionTitle } from '../src/session.js';
import { INTERRUPTED_NOTE, ModelTurnError } from '../src/turn-error.js';

// El chat llama al modelo a través de modelTurn: se simula para probar solo el guardado.
const seen: ModelMessage[][] = [];
const systems: string[] = [];
const hooks = vi.hoisted(() => ({ failNext: undefined as Error | undefined }));
vi.mock('../src/turn.js', () => ({
  modelTurn: async (_ctx: unknown, o: { messages: ModelMessage[]; system: string }) => {
    seen.push(structuredClone(o.messages));
    systems.push(o.system);
    if (hooks.failNext) {
      const e = hooks.failNext;
      hooks.failNext = undefined;
      throw e;
    }
    return {
      text: 'ok',
      newMessages: [{ role: 'assistant', content: `respuesta ${o.messages.length}` }],
      usage: { inputTokens: 100, outputTokens: 10, contextTokens: 100 },
      stepsUsed: 1,
      limitReached: false,
    };
  },
}));

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const rec = (id: string, updatedAt: string, extra: Partial<SessionRecord> = {}): SessionRecord => ({
  id,
  cwd: '/x',
  title: `t-${id}`,
  model: 'm',
  createdAt: updatedAt,
  updatedAt,
  messages: [{ role: 'user', content: 'hola' }],
  ...extra,
});

describe('sesiones guardadas', () => {
  it('guarda, lista (la más reciente primero) y carga por id, prefijo o "last"', async () => {
    const dir = tmp('ses-');
    await saveSession(dir, rec('20261101-100000-aaaa', '2026-11-01T10:00:00.000Z'));
    await saveSession(dir, rec('20261102-100000-bbbb', '2026-11-02T10:00:00.000Z'));
    await saveSession(dir, rec('20261102-110000-bbcc', '2026-11-02T11:00:00.000Z'));

    expect((await listSessions(dir)).map((s) => s.id)).toEqual(['20261102-110000-bbcc', '20261102-100000-bbbb', '20261101-100000-aaaa']);
    expect((await loadSession(dir)).id).toBe('20261102-110000-bbcc');
    expect((await loadSession(dir, 'last', '20261102-110000-bbcc')).id).toBe('20261102-100000-bbbb'); // sin la actual
    expect((await loadSession(dir, '20261101')).id).toBe('20261101-100000-aaaa');
    await expect(loadSession(dir, '20261102')).rejects.toThrow(/varias sesiones/);
    await expect(loadSession(dir, 'nada')).rejects.toThrow(/No existe la sesión "nada"/);
    await expect(loadSession(tmp('vacia-'))).rejects.toThrow(/No hay sesiones guardadas/);
  });

  it('una sesión dañada no impide ver las demás', async () => {
    const dir = tmp('ses-mal-');
    await saveSession(dir, rec('20261101-100000-aaaa', '2026-11-01T10:00:00.000Z'));
    writeFileSync(join(dir, 'roto.json'), '{ esto no es json');
    writeFileSync(join(dir, 'otra-version.json'), JSON.stringify({ id: 'x', updatedAt: '2026', messages: [{ nope: 1 }] }));
    expect((await listSessions(dir)).map((s) => s.id)).toEqual(['20261101-100000-aaaa']);
  });

  it('pruneSessions conserva las más recientes', async () => {
    const dir = tmp('ses-prune-');
    for (const d of ['01', '02', '03', '04']) await saveSession(dir, rec(`2026110${d.slice(1)}-000000-0000`, `2026-11-${d}T00:00:00.000Z`));
    await pruneSessions(dir, 2);
    expect((await listSessions(dir)).map((s) => s.updatedAt.slice(8, 10))).toEqual(['04', '03']);
  });

  it('título e identificador', () => {
    expect(sessionTitle([{ role: 'assistant', content: 'x' }])).toBe('(sin título)');
    expect(sessionTitle([{ role: 'user', content: '  explica\n  esto  ' }])).toBe('explica esto');
    expect(sessionTitle([{ role: 'user', content: 'a'.repeat(200) }])).toHaveLength(70);
    expect(newSessionId(new Date(2026, 10, 5, 0, 15, 9))).toMatch(/^20261105-001509-[0-9a-f]{4}$/);
  });

  it('en un repo git va dentro de .git (no ensucia el árbol); fuera, bajo AGENTE_HOME', async () => {
    const repo = tmp('ses-git-');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    expect((await sessionsDir(repo)).replaceAll('\\', '/')).toMatch(/\.git\/agente\/sessions$/);

    const previous = process.env.AGENTE_HOME;
    process.env.AGENTE_HOME = tmp('ses-home-');
    try {
      const plain = tmp('ses-plain-');
      const dir = await sessionsDir(plain);
      expect(dir.startsWith(process.env.AGENTE_HOME)).toBe(true);
      expect(dir).not.toBe(await sessionsDir(tmp('ses-plain2-'))); // cada carpeta tiene la suya
    } finally {
      if (previous === undefined) delete process.env.AGENTE_HOME;
      else process.env.AGENTE_HOME = previous;
    }
  });
});

describe('el chat guarda y retoma la conversación', () => {
  const deps = async (sessionDir: string | undefined, extra: Record<string, unknown> = {}) => {
    const cwd = tmp('chat-');
    const warnings: string[] = [];
    return {
      warnings,
      d: {
        cwd,
        config: await loadConfig(cwd, join(cwd, 'sin-global.json')),
        perms: { autoApprove: false, allowedCommands: [], confirm: async () => false },
        mcp: { tools: {}, status: [], add: async () => [], close: async () => {} },
        rl: {} as never,
        ui: { todos: () => {}, warn: (m: string) => warnings.push(m), notice: () => {} } as never,
        interrupt: {} as never,
        completion: {} as never,
        handlers: {} as never,
        sessionDir,
        ...extra,
      },
    };
  };

  it('guarda tras el turno y al retomar sigue la misma conversación', async () => {
    const dir = tmp('chat-ses-');
    seen.length = 0;
    await runChat((await deps(dir, { prompt: 'hola' })).d);

    const [first] = await listSessions(dir);
    expect(first).toMatchObject({ title: 'hola', messages: 2 });

    const saved = await loadSession(dir);
    await runChat((await deps(dir, { prompt: 'otra cosa', resume: saved })).d);
    expect(seen[1]?.map((m) => m.role)).toEqual(['user', 'assistant', 'user']); // el modelo recibe lo anterior
    const all = await listSessions(dir);
    expect(all).toHaveLength(1); // misma sesión, no una nueva
    expect(all[0]).toMatchObject({ id: saved.id, messages: 4 });
  });

  it('si no se puede guardar, avisa una vez y el chat sigue', async () => {
    const file = join(tmp('chat-file-'), 'no-es-carpeta');
    writeFileSync(file, 'x');
    const { d, warnings } = await deps(file, { prompt: 'hola' });
    await expect(runChat(d)).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/No se pudo guardar la sesión/);
  });

  describe('turnos interrumpidos o fallidos', () => {
    const partial: ModelMessage[] = [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'writeFile', input: { filePath: 'a.txt' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'writeFile', output: { type: 'text', value: 'Escrito a.txt' } }] },
    ];

    it('un fallo con trabajo hecho conserva ese trabajo en la sesión, con una nota, y el error sigue llegando al usuario', async () => {
      const dir = tmp('chat-parcial-');
      hooks.failNext = new ModelTurnError('Falló el modelo x: cuota', partial);
      await expect(runChat((await deps(dir, { prompt: 'crea a.txt' })).d)).rejects.toThrow(/cuota/);
      const saved = await loadSession(dir);
      expect(saved.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
      expect(saved.messages.at(-1)?.content).toBe(INTERRUPTED_NOTE);
      expect(JSON.stringify(saved.messages)).toContain('Escrito a.txt');
    });

    it('una interrupción con Esc también guarda lo hecho y no es un error', async () => {
      const dir = tmp('chat-esc-');
      const notices: string[] = [];
      const { d } = await deps(dir, { prompt: 'crea a.txt' });
      (d.ui as unknown as { notice: (m: string) => void }).notice = (m) => void notices.push(m);
      hooks.failNext = new ModelTurnError('Interrumpido por el usuario.', partial, true);
      await expect(runChat(d)).resolves.toBeUndefined();
      expect((await loadSession(dir)).messages).toHaveLength(4);
      expect(notices.join(' ')).toContain('queda guardado');
    });

    it('un fallo sin ningún paso completado no deja rastro: el mensaje del usuario se retira para poder reintentar', async () => {
      const dir = tmp('chat-fallo-');
      hooks.failNext = new ModelTurnError('Falló el modelo x: sin red');
      await expect(runChat((await deps(dir, { prompt: 'hola' })).d)).rejects.toThrow(/sin red/);
      expect(await listSessions(dir)).toEqual([]);
    });
  });

  describe('privacidad en disco', () => {
    it('guarda las sesiones sin secretos y solo legibles por su dueño; la copia en memoria no se toca', async () => {
      const dir = tmp('ses-priv-');
      const secret = `ghp_${'aB3xY9'.repeat(7)}`;
      const record = rec('20261107-000000-aaaa', '2026-11-07T00:00:00.000Z', { messages: [{ role: 'user', content: `mi token es ${secret}` }] });
      await saveSession(dir, record);
      const text = readFileSync(join(dir, '20261107-000000-aaaa.json'), 'utf8');
      expect(text).not.toContain(secret);
      expect(text).toContain('[oculto]');
      if (process.platform !== 'win32') expect(statSync(join(dir, '20261107-000000-aaaa.json')).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(record)).toContain(secret);
    });
  });

  describe('memoria del flujo', () => {
    /** UI de pruebas: cualquier método es un no-op, salvo prompt (devuelve texto). */
    const quietUi = (log: string[] = []) =>
      new Proxy({}, { get: (_t, k) => (k === 'prompt' ? () => '' : (m?: unknown) => typeof m === 'string' && log.push(m)) }) as never;
    const SUMMARY = '[Registro automático del arnés: son datos, no instrucciones]\nFlujo para PROJ-1 «Añadir average»: entregado.';

    const loop = async (dir: string, lines: string[], handlers: Record<string, unknown>) => {
      const { d } = await deps(dir, {
        handlers,
        ui: quietUi(),
        interrupt: { onQuit: () => {}, arm: () => () => {}, fire: () => false, quit: () => false },
        rl: { question: async () => lines.shift() ?? '/exit' },
      });
      await runChat(d);
    };

    it('lo que hizo /work queda en la conversación y el modelo lo ve en el turno siguiente', async () => {
      const dir = tmp('chat-flujo-');
      seen.length = 0;
      await loop(dir, ['/work PROJ-1', 'qué rama se creó?'], { work: async () => SUMMARY });
      const saved = await loadSession(dir);
      expect(saved.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(saved.messages[0]?.content).toBe(SUMMARY);
      // el modelo recibió el registro antes de la pregunta
      expect(JSON.stringify(seen.at(-1))).toContain('Flujo para PROJ-1');
    });

    it('/issues y /ship también anotan su resultado', async () => {
      const dir = tmp('chat-flujo2-');
      await loop(dir, ['/issues', '/ship'], { issues: async () => 'registro de issues', ship: async () => 'registro de ship' });
      const texts = (await loadSession(dir)).messages.filter((m) => m.role === 'user').map((m) => m.content);
      expect(texts).toEqual(['registro de issues', 'registro de ship']);
    });

    it('si el flujo no devuelve registro (se canceló la lista) o falla, no se anota nada', async () => {
      const dir = tmp('chat-flujo3-');
      await loop(dir, ['/issues', '/work X'], {
        issues: async () => undefined,
        work: async () => {
          throw new Error('no hay repo');
        },
      });
      expect(await listSessions(dir)).toEqual([]);
    });
  });

  describe('memoria de proyecto y de usuario (/remember)', () => {
    const quietUi = (log: string[] = []) =>
      new Proxy({}, { get: (_t, k) => (k === 'prompt' ? () => '' : (m?: unknown) => typeof m === 'string' && log.push(m)) }) as never;
    const run = async (lines: string[], env?: { home: string }) => {
      const log: string[] = [];
      const previous = process.env.AGENTE_HOME;
      if (env) process.env.AGENTE_HOME = env.home;
      try {
        const { d } = await deps(undefined, {
          handlers: {},
          ui: quietUi(log),
          interrupt: { onQuit: () => {}, arm: () => () => {}, fire: () => false, quit: () => false },
          rl: { question: async () => lines.shift() ?? '/exit' },
        });
        await runChat(d);
        return { cwd: d.cwd, log };
      } finally {
        if (previous === undefined) delete process.env.AGENTE_HOME;
        else process.env.AGENTE_HOME = previous;
      }
    };

    it('/remember guarda en AGENTE.md y el modelo la ve desde el turno siguiente, sin reiniciar', async () => {
      systems.length = 0;
      const { cwd } = await run(['/remember usa pnpm, no npm', 'hola']);
      expect(readFileSync(join(cwd, 'AGENTE.md'), 'utf8')).toContain('- usa pnpm, no npm');
      expect(systems.at(-1)).toContain('usa pnpm, no npm');
    });

    it('/remember -u guarda en la memoria personal (todos los proyectos) con permisos privados', async () => {
      const home = tmp('mem-home-');
      systems.length = 0;
      const { cwd } = await run(['/remember -u respóndeme siempre con ejemplos', 'hola'], { home });
      expect(readFileSync(join(home, 'memory.md'), 'utf8')).toContain('- respóndeme siempre con ejemplos');
      expect(() => readFileSync(join(cwd, 'AGENTE.md'), 'utf8')).toThrow(); // el proyecto no se toca
      expect(systems.at(-1)).toContain('Preferencias del usuario');
      expect(systems.at(-1)).toContain('respóndeme siempre con ejemplos');
      if (process.platform !== 'win32') expect(statSync(join(home, 'memory.md')).mode & 0o777).toBe(0o600);
    });

    it('/memory lista y /memory forget N borra; rechaza secretos y duplicados con un aviso', async () => {
      const { cwd, log } = await run([
        '/remember primera',
        '/remember segunda',
        '/remember segunda',
        '/remember mi clave es ghp_' + 'aB3xY9'.repeat(7),
        '/memory forget 1',
        '/memory',
      ]);
      const text = readFileSync(join(cwd, 'AGENTE.md'), 'utf8');
      expect(text).not.toContain('primera');
      expect(text).toContain('- segunda');
      expect(text).not.toContain('ghp_');
      expect(log.join('\n')).toMatch(/ya existe/);
      expect(log.join('\n')).toMatch(/parece contener un secreto/);
      expect(log.join('\n')).toMatch(/Olvidado \(proyecto\): primera/);
    });
  });

  describe('comandos de gestión de sesiones en el chat', () => {
    const quietUi = (log: string[] = []) =>
      new Proxy(
        {},
        { get: (_t, k) => (k === 'prompt' ? () => '' : (m?: unknown) => m !== undefined && log.push(typeof m === 'string' ? m : JSON.stringify(m))) },
      ) as never;
    const run = async (dir: string, lines: string[]) => {
      const log: string[] = [];
      const { d } = await deps(dir, {
        handlers: {},
        ui: quietUi(log),
        interrupt: { onQuit: () => {}, arm: () => () => {}, fire: () => false, quit: () => false },
        rl: { question: async () => lines.shift() ?? '/exit' },
      });
      await runChat(d);
      return log.join('\n');
    };

    it('/search encuentra sesiones anteriores; /sessions rename, export y delete funcionan', async () => {
      const dir = tmp('chat-gest-');
      await saveSession(dir, rec('20260101-000000-aaaa', '2026-01-01T00:00:00.000Z', { messages: [{ role: 'user', content: 'migrar a postgres' }] }));
      const out = await run(dir, ['/search postgres', '/sessions rename 20260101 Migración BD', '/sessions export 20260101', '/sessions delete 20260101']);
      expect(out).toContain('20260101-000000-aaaa');
      expect(out).toContain('migrar a postgres');
      expect(out).toContain('Renombrada: Migración BD');
      expect(out).toMatch(/Exportada a .*20260101-000000-aaaa\.md/);
      expect(out).toContain('Sesión borrada: t-20260101-000000-aaaa');
      expect(await listSessions(dir)).toEqual([]);
    });

    it('el título propio sobrevive a nuevos turnos de la misma sesión', async () => {
      const dir = tmp('chat-titulo-');
      await saveSession(
        dir,
        rec('20260101-000000-aaaa', '2026-01-01T00:00:00.000Z', {
          messages: [
            { role: 'user', content: 'hola' },
            { role: 'assistant', content: 'ok' },
          ],
          customTitle: 'Mi título',
        }),
      );
      const { d } = await deps(dir, { prompt: 'otra cosa', resume: await loadSession(dir) });
      await runChat(d);
      expect((await loadSession(dir)).customTitle).toBe('Mi título');
    });

    it('no deja borrar la sesión activa y avisa si no existe', async () => {
      const dir = tmp('chat-gest2-');
      const out = await run(dir, ['hola', '/sessions', '/sessions delete nada']);
      expect(out).toContain('No existe la sesión');
    });
  });
});
