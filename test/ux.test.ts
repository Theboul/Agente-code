import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { distance, normalizeArgs, parseInvocation } from '../src/invocation.js';
import { authorizeDetailed, denialMessage, MODES, nextMode, type PermissionKind, type PermissionRequest, type Permissions } from '../src/permissions.js';
import { stripAnsi } from '../src/ui/ansi.js';
import { type CompletionState, createCompleter } from '../src/ui/complete.js';
import { createDecisionPrompter } from '../src/ui/dialog.js';
import { appendHistory, loadHistory } from '../src/ui/history.js';
import { Ui } from '../src/ui/render.js';
import type { Key, KeySource } from '../src/ui/select.js';

describe('--resume sin id', () => {
  it('sin id pasa a id vacío (la CLI muestra la lista); con id se respeta', () => {
    expect(normalizeArgs(['--resume'])).toEqual(['--resume=']);
    expect(normalizeArgs(['--resume', '-m', 'x/y'])).toEqual(['--resume=', '-m', 'x/y']);
    expect(normalizeArgs(['-m', 'x/y', '--resume'])).toEqual(['-m', 'x/y', '--resume=']);
    expect(normalizeArgs(['--resume', '20261105-001500-a3f9'])).toEqual(['--resume', '20261105-001500-a3f9']);
    expect(normalizeArgs(['work', 'DP-1'])).toEqual(['work', 'DP-1']);
  });
});

describe('atajos de la línea de comandos', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inv-'));
  writeFileSync(join(dir, 'tarea.md'), '# Tarea\ncuerpo');

  it('sin argumentos abre la sesión y los comandos conocidos se respetan', () => {
    expect(parseInvocation([], dir)).toEqual({ cmd: 'chat', args: [] });
    expect(parseInvocation(['work', 'PROJ-1'], dir)).toEqual({ cmd: 'work', args: ['PROJ-1'] });
    expect(parseInvocation(['ship', 'feat/x'], dir)).toEqual({ cmd: 'ship', args: ['feat/x'] });
    expect(parseInvocation(['issues'], dir)).toEqual({ cmd: 'issues', args: [] });
  });

  it('una clave de issue, #número, URL o archivo .md arranca el flujo directo', () => {
    expect(parseInvocation(['PROJ-123'], dir)).toEqual({ cmd: 'work', args: ['PROJ-123'] });
    expect(parseInvocation(['#45'], dir)).toEqual({ cmd: 'work', args: ['#45'] });
    expect(parseInvocation(['https://x.atlassian.net/browse/A-1'], dir).cmd).toBe('work');
    expect(parseInvocation(['tarea.md'], dir)).toEqual({ cmd: 'work', args: ['tarea.md'] });
  });

  it('texto libre abre la sesión con ese primer mensaje', () => {
    expect(parseInvocation(['explica', 'el', 'módulo', 'de', 'pagos'], dir)).toEqual({ cmd: 'chat', args: [], initialPrompt: 'explica el módulo de pagos' });
    expect(parseInvocation(['hola'], dir).initialPrompt).toBe('hola');
  });

  it('una errata de un comando se sugiere en lugar de abrir el chat', () => {
    expect(parseInvocation(['isues'], dir).suggest).toBe('issues');
    expect(parseInvocation(['shpi'], dir).suggest).toBe('ship');
    expect(parseInvocation(['isues', 'abiertas'], dir).suggest).toBeUndefined(); // varias palabras: es una pregunta
    expect(parseInvocation(['api'], dir).suggest).toBeUndefined(); // demasiado corto para confundirse
    expect(distance('kitten', 'sitting')).toBe(3);
  });
});

describe('autocompletado con Tab', () => {
  const state: CompletionState = {
    commands: ['/work', '/issues', '/ship', '/mode', '/model', '/role', '/exit'],
    issues: ['PROJ-12', 'PROJ-34', 'ABC-1'],
    branches: ['feat/proj-12-login'],
    models: ['google/gemini-3.5-flash-lite', 'anthropic/claude-sonnet-5-5'],
    roles: ['plan', 'implement', 'light'],
    modes: [...MODES],
    trackers: ['jira', 'trello', 'github'],
    suppress: false,
  };
  const complete = createCompleter(() => state);

  it('completa comandos con "/"', () => {
    expect(complete('/')[0]).toEqual(state.commands);
    expect(complete('/mo')).toEqual([['/mode', '/model'], '/mo']);
    expect(complete('/w')).toEqual([['/work'], '/w']);
  });

  it('completa el argumento según el comando', () => {
    expect(complete('/work PR')).toEqual([['PROJ-12', 'PROJ-34'], 'PR']);
    expect(complete('/work proj-3')).toEqual([['PROJ-34'], 'proj-3']);
    expect(complete('/ship ')).toEqual([['feat/proj-12-login'], '']);
    expect(complete('/model anth')).toEqual([['anthropic/claude-sonnet-5-5'], 'anth']);
    expect(complete('/role pl')).toEqual([['plan'], 'pl']);
    expect(complete('/mode e')).toEqual([['edits'], 'e']);
    expect(complete('/connect t')).toEqual([['trello'], 't']);
  });

  it('no completa texto normal ni comandos sin lista', () => {
    expect(complete('hola')).toEqual([[], 'hola']);
    expect(complete('/clear x')).toEqual([[], 'x']);
  });

  it('Shift+Tab (suppress) anula un único completado', () => {
    state.suppress = true;
    expect(complete('/wo')).toEqual([[], '/wo']);
    expect(state.suppress).toBe(false);
    expect(complete('/wo')[0]).toEqual(['/work']);
  });
});

describe('historial entre sesiones', () => {
  it('guarda, ignora vacíos y repetidos seguidos, y lo devuelve de más reciente a más antigua', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hist-')), 'sub', 'history');
    expect(await loadHistory(file)).toEqual([]);
    for (const l of ['uno', '  ', 'dos', 'dos', 'tres\ncon salto']) await appendHistory(file, l);
    expect(await loadHistory(file)).toEqual(['tres con salto', 'dos', 'uno']);
    expect(readFileSync(file, 'utf8')).toBe('uno\ndos\ntres con salto\n');
  });

  it('el archivo es privado y se limita a las últimas 500 entradas', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hist-')), 'history');
    writeFileSync(file, `${Array.from({ length: 520 }, (_, i) => `l${i}`).join('\n')}\n`);
    await appendHistory(file, 'nueva');
    const h = await loadHistory(file);
    expect(h).toHaveLength(500);
    expect(h[0]).toBe('nueva');
    // Windows no tiene bits POSIX: chmod 600 no cambia el modo que informa stat.
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('modos de permisos', () => {
  const req = (kind: PermissionKind): PermissionRequest => ({ kind, title: 't', question: 'q' });
  const perms = (mode: Permissions['mode'], over: Partial<Permissions> = {}): Permissions & { asked: number } => {
    const p = { asked: 0, mode, autoApprove: false, allowedCommands: [], confirm: async () => false, ...over } as Permissions & { asked: number };
    p.prompt = async () => (p.asked++, { allow: true });
    return p;
  };

  it('Shift+Tab recorre preguntar → ediciones → plan → preguntar', () => {
    expect(nextMode('ask')).toBe('edits');
    expect(nextMode('edits')).toBe('plan');
    expect(nextMode('plan')).toBe('ask');
  });

  it('preguntar: todo pasa por el diálogo', async () => {
    const p = perms('ask');
    for (const k of ['edit', 'create', 'delete', 'command'] as const) expect(await authorizeDetailed(p, 'ask', req(k))).toEqual({ allow: true });
    expect(p.asked).toBe(4);
  });

  it('aceptar ediciones: edita y crea solo; borrar, mover y comandos siguen preguntando', async () => {
    const p = perms('edits');
    expect(await authorizeDetailed(p, 'ask', req('edit'))).toEqual({ allow: true });
    expect(await authorizeDetailed(p, 'ask', req('create'))).toEqual({ allow: true });
    expect(p.asked).toBe(0);
    for (const k of ['delete', 'move', 'command', 'mcp', 'web'] as const) await authorizeDetailed(p, 'ask', req(k));
    expect(p.asked).toBe(5);
  });

  it('solo plan: ningún cambio, con un motivo que ve el modelo; la lectura web sigue permitida con diálogo', async () => {
    const p = perms('plan');
    for (const k of ['edit', 'create', 'delete', 'move', 'command', 'mcp', 'workflow'] as const) {
      const r = await authorizeDetailed(p, 'ask', req(k));
      expect(r).toMatchObject({ allow: false });
      expect(r.allow === false && r.reason).toContain('Modo solo plan');
      expect(denialMessage(r)).toMatch(/^DENEGADO: Modo solo plan/);
    }
    expect(p.asked).toBe(0);
    expect(await authorizeDetailed(p, 'ask', req('web'))).toEqual({ allow: true });
  });

  it('los modos nunca saltan lo bloqueado ni lo permitido de antemano', async () => {
    const p = perms('edits');
    expect(await authorizeDetailed(p, 'deny', req('edit'))).toEqual({ allow: false });
    expect(await authorizeDetailed(perms('plan'), 'allow', req('command'))).toEqual({ allow: true });
  });
});

describe('plan con ediciones automáticas', () => {
  const keys = (...ks: [string | undefined, Key][]): KeySource => ({
    listen(handler) {
      let on = true;
      (async () => {
        for (const [s, k] of ks) {
          await new Promise((r) => setImmediate(r));
          if (on) handler(s, k);
        }
      })();
      return () => {
        on = false;
      };
    },
  });
  const prompt = { title: 'Plan', approve: 'Sí', approveWithEdits: 'Sí y ediciones solas', cancel: 'No', feedback: 'Cambios' };
  const dp = (k: KeySource) => createDecisionPrompter({ keys: k, out: { write: () => {} }, ask: async () => 'x', interactive: () => true });

  it('la segunda opción aprueba y activa las ediciones automáticas', async () => {
    expect(await dp(keys(['2', {}]))(prompt)).toEqual({ kind: 'approve', allowEdits: true });
    expect(await dp(keys(['1', {}]))(prompt)).toEqual({ kind: 'approve' });
    expect(await dp(keys(['3', {}]))(prompt)).toEqual({ kind: 'feedback', text: 'x' });
    expect(await dp(keys(['4', {}]))(prompt)).toEqual({ kind: 'cancel' });
  });
});

describe('regla con el modo', () => {
  it('muestra el modo en la regla sobre la entrada y la redibuja sin tocar lo escrito', () => {
    const chunks: string[] = [];
    const ui = new Ui({ write: (s) => chunks.push(s), isTTY: true });
    expect(stripAnsi(ui.prompt('modo: preguntar · Shift+Tab cambia'))).toMatch(/^\n── modo: preguntar · Shift\+Tab cambia ─+\n› $/);
    ui.redrawRule('modo: solo plan', 3);
    expect(stripAnsi(chunks.join(''))).toContain('modo: solo plan');
    chunks.length = 0;
    ui.redrawRule('x', 500); // entrada demasiado larga: no se redibuja
    expect(chunks).toEqual([]);
  });
});
