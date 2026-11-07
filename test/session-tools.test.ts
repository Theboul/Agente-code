import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { listSessions, loadSession, type SessionRecord, saveSession } from '../src/session.js';
import { deleteSession, exportSession, messageText, renameSession, searchSessions, sessionToMarkdown } from '../src/session-tools.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'st-'));
const rec = (id: string, updatedAt: string, messages: ModelMessage[], extra: Partial<SessionRecord> = {}): SessionRecord => ({
  id,
  cwd: '/x',
  title: `t-${id}`,
  model: 'm',
  createdAt: updatedAt,
  updatedAt,
  messages,
  ...extra,
});

const seed = async () => {
  const dir = tmp();
  await saveSession(
    dir,
    rec('20261101-100000-aaaa', '2026-11-01T10:00:00.000Z', [
      { role: 'user', content: 'arregla el LOGIN de google' },
      { role: 'assistant', content: 'listo' },
    ]),
  );
  await saveSession(
    dir,
    rec('20261102-100000-bbbb', '2026-11-02T10:00:00.000Z', [
      { role: 'user', content: 'qué hace el login?' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'readFile', input: { filePath: 'src/login.ts' } }] },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'readFile', output: { type: 'text', value: 'export function login() { /* login */ }' } }],
      },
    ]),
  );
  await saveSession(dir, rec('20261103-100000-cccc', '2026-11-03T10:00:00.000Z', [{ role: 'user', content: 'hola' }]));
  return dir;
};

describe('buscar en las sesiones', () => {
  it('encuentra sin distinguir mayúsculas, ordena por coincidencias y luego por fecha, y da un fragmento', async () => {
    const hits = await searchSessions(await seed(), 'login');
    expect(hits.map((h) => h.id)).toEqual(['20261102-100000-bbbb', '20261101-100000-aaaa']); // 4 coincidencias vs 1
    expect(hits[0]?.matches).toBeGreaterThan(hits[1]!.matches);
    expect(hits[1]?.snippet).toContain('LOGIN de google');
  });

  it('también busca dentro de llamadas y resultados de herramientas', async () => {
    const hits = await searchSessions(await seed(), 'src/login.ts');
    expect(hits.map((h) => h.id)).toEqual(['20261102-100000-bbbb']);
  });

  it('sin resultados, consulta vacía y límite', async () => {
    const dir = await seed();
    expect(await searchSessions(dir, 'zzz')).toEqual([]);
    expect(await searchSessions(dir, '   ')).toEqual([]);
    expect(await searchSessions(dir, 'login', 1)).toHaveLength(1);
  });

  it('messageText aplana texto, llamadas y resultados', () => {
    expect(messageText({ role: 'user', content: 'hola' })).toBe('hola');
    expect(messageText({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'grep', input: { pattern: 'x' } }] })).toBe(
      'grep({"pattern":"x"})',
    );
  });
});

describe('borrar, renombrar y exportar', () => {
  it('borra por prefijo, protege la sesión activa y exige una referencia', async () => {
    const dir = await seed();
    await expect(deleteSession(dir, '')).rejects.toThrow(/Indica el id/);
    await expect(deleteSession(dir, 'last')).rejects.toThrow(/Indica el id/);
    await expect(deleteSession(dir, '20261103', '20261103-100000-cccc')).rejects.toThrow(/sesión activa/);
    expect((await deleteSession(dir, '20261101')).id).toBe('20261101-100000-aaaa');
    expect((await listSessions(dir)).map((s) => s.id)).toEqual(['20261103-100000-cccc', '20261102-100000-bbbb']);
    await expect(deleteSession(dir, 'nada')).rejects.toThrow(/No existe la sesión/);
  });

  it('renombra: el título propio persiste y se usa al buscar', async () => {
    const dir = await seed();
    const renamed = await renameSession(dir, '20261102', '  Revisión   del login  ');
    expect(renamed.customTitle).toBe('Revisión del login');
    expect((await loadSession(dir, '20261102')).customTitle).toBe('Revisión del login');
    expect((await searchSessions(dir, 'login'))[0]?.title).toBe('Revisión del login');
    await expect(renameSession(dir, '20261102', '   ')).rejects.toThrow(/vacío/);
  });

  it('exporta a Markdown con permisos privados y recorta resultados largos de herramientas', async () => {
    const dir = await seed();
    const file = await exportSession(dir, '20261102');
    expect(file.replaceAll('\\', '/')).toMatch(/exports\/20261102-100000-bbbb\.md$/);
    const md = readFileSync(file, 'utf8');
    expect(md).toContain('# t-20261102-100000-bbbb');
    expect(md).toContain('## Usuario\n\nqué hace el login?');
    expect(md).toContain('readFile({"filePath":"src/login.ts"})');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);

    const long = sessionToMarkdown(
      rec('x', '2026-11-01T00:00:00.000Z', [
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 't', output: { type: 'text', value: 'y'.repeat(2000) } }] },
      ]),
    );
    expect(long).toContain('…[recortado]');
  });
});
