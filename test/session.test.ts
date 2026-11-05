import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { runChat } from '../src/chat.js';
import { loadConfig } from '../src/config.js';
import { listSessions, loadSession, newSessionId, pruneSessions, type SessionRecord, saveSession, sessionsDir, sessionTitle } from '../src/session.js';

// El chat llama al modelo a través de modelTurn: se simula para probar solo el guardado.
const seen: ModelMessage[][] = [];
vi.mock('../src/turn.js', () => ({
  modelTurn: async (_ctx: unknown, o: { messages: ModelMessage[] }) => {
    seen.push(structuredClone(o.messages));
    return { text: 'ok', newMessages: [{ role: 'assistant', content: `respuesta ${o.messages.length}` }] };
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
});
