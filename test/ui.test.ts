import { describe, expect, it } from 'vitest';
import { workflowTool } from '../src/chat.js';
import { authorizeDetailed, commandSessionKey, denialMessage, type PermissionRequest, type Permissions } from '../src/permissions.js';
import { stripAnsi, truncate, visibleWidth } from '../src/ui/ansi.js';
import { box, wrapText } from '../src/ui/box.js';
import { createDecisionPrompter, createPermissionPrompter, dialogOptions, renderDialog } from '../src/ui/dialog.js';
import { formatMarkdownLine, summarizeResult, toolLabel, Ui } from '../src/ui/render.js';
import { type Key, type KeySource, selectIndex } from '../src/ui/select.js';
import { decide, type WorkflowIO } from '../src/workflow/run.js';

/** Teclas simuladas: se entregan una a una mientras alguien escucha. */
function fakeKeys(...keys: [string | undefined, Key][]): KeySource & { listens: number } {
  const src = {
    listens: 0,
    listen(handler: (s: string | undefined, k: Key) => void) {
      src.listens++;
      let active = true;
      (async () => {
        for (const [s, k] of keys) {
          await new Promise((r) => setImmediate(r));
          if (!active) return;
          handler(s, k);
        }
      })();
      return () => {
        active = false;
      };
    },
  };
  return src;
}
const key = (name: string, str?: string): [string | undefined, Key] => [str, { name }];
const sink = () => {
  const chunks: string[] = [];
  return { chunks, out: { write: (s: string) => chunks.push(s) }, text: () => chunks.join('') };
};

describe('primitivas de texto', () => {
  it('mide, recorta y quita códigos de color', () => {
    expect(stripAnsi('\u001b[31mhola\u001b[39m')).toBe('hola');
    expect(visibleWidth('\u001b[1mabc\u001b[22m')).toBe(3);
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
    expect(truncate('abc', 5)).toBe('abc');
  });

  it('dibuja cuadros con título y recorta líneas largas sin romper el borde', () => {
    const lines = box(['corto', 'x'.repeat(100)], { title: 'Editar', width: 30 });
    expect(lines[0]).toMatch(/^╭─ Editar ─+╮$/);
    expect(lines.at(-1)).toMatch(/^╰─+╯$/);
    expect(new Set(lines.map((l) => [...l].length))).toEqual(new Set([30]));
    expect(lines[2]).toContain('…');
  });

  it('parte texto largo por palabras', () => {
    expect(wrapText('uno dos tres cuatro', 9)).toEqual(['uno dos', 'tres', 'cuatro']);
    expect(wrapText('a\n\nb', 10)).toEqual(['a', '', 'b']);
  });
});

describe('selector con teclado', () => {
  const render = (n: number) => (sel: number) => Array.from({ length: n }, (_, i) => `${i === sel ? '>' : ' '} opción ${i + 1}`);

  it('flechas y Enter', async () => {
    const o = sink();
    const r = await selectIndex({ count: 3, render: render(3), keys: fakeKeys(key('down'), key('down'), key('up'), key('return')), out: o.out });
    expect(r).toBe(1);
    expect(o.text()).toContain('> opción 2');
  });

  it('las flechas dan la vuelta', async () => {
    expect(await selectIndex({ count: 3, render: render(3), keys: fakeKeys(key('up'), key('return')), out: sink().out })).toBe(2);
  });

  it('un número elige al instante y se ignora si no existe esa opción', async () => {
    expect(await selectIndex({ count: 3, render: render(3), keys: fakeKeys(['9', {}], ['2', {}]), out: sink().out })).toBe(1);
  });

  it('Esc y Ctrl+C cancelan', async () => {
    expect(await selectIndex({ count: 3, render: render(3), keys: fakeKeys(key('escape')), out: sink().out })).toBe('cancel');
    expect(await selectIndex({ count: 3, render: render(3), keys: fakeKeys([undefined, { name: 'c', ctrl: true }]), out: sink().out })).toBe('cancel');
  });

  it('con clear borra el cuadro al terminar', async () => {
    const o = sink();
    await selectIndex({ count: 2, render: render(2), keys: fakeKeys(key('return')), out: o.out, clear: true });
    expect(o.text()).toContain(`${String.fromCharCode(27)}[2A`);
  });
});

describe('diálogo de permisos', () => {
  const edit: PermissionRequest = {
    kind: 'edit',
    title: 'Editar archivo',
    target: 'src/math.js',
    preview: ['desde la línea 2:', '- const a = 1;', '+ const a = 9;'],
    question: '¿?',
    session: { key: 'edits', label: 'las ediciones' },
  };

  it('muestra qué se hace, la vista previa y las opciones numeradas', () => {
    const text = stripAnsi(renderDialog(edit, dialogOptions(edit), 0, 80).join('\n'));
    expect(text).toContain('Editar archivo');
    expect(text).toContain('src/math.js');
    expect(text).toContain('- const a = 1;');
    expect(text).toContain('+ const a = 9;');
    expect(text).toContain('¿Quieres aplicar este cambio?');
    expect(text).toContain('❯ 1. Sí');
    expect(text).toContain('2. Sí, no volver a preguntar por las ediciones en esta sesión');
    expect(text).toContain('3. No, y decirle al agente qué hacer distinto');
  });

  it('sin clave de sesión solo hay dos opciones', () => {
    expect(dialogOptions({ ...edit, session: undefined }).map((o) => o.id)).toEqual(['yes', 'no']);
  });

  const prompter = (keys: KeySource, answer?: string) => {
    const o = sink();
    return { o, p: createPermissionPrompter({ keys, out: o.out, ask: async () => answer, interactive: () => true }) };
  };

  it('Sí permite una vez y vuelve a preguntar', async () => {
    const keys = fakeKeys(key('return'), key('return'));
    const { p } = prompter(keys);
    expect(await p(edit)).toEqual({ allow: true });
    expect(await p(edit)).toEqual({ allow: true });
    expect(keys.listens).toBe(2);
  });

  it('"No volver a preguntar" recuerda la clave durante la sesión y no abre más diálogos', async () => {
    const keys = fakeKeys(key('down'), key('return'));
    const { p, o } = prompter(keys);
    expect(await p(edit)).toEqual({ allow: true });
    expect(o.text()).toContain('permitido en esta sesión');
    expect(await p(edit)).toEqual({ allow: true });
    expect(await p({ ...edit, target: 'otro.js' })).toEqual({ allow: true }); // misma clave: cualquier edición
    expect(keys.listens).toBe(1);
    // otra clave distinta sigue preguntando
    const cmd: PermissionRequest = {
      kind: 'command',
      title: 'Ejecutar comando',
      target: '$ npm test',
      question: '?',
      session: { key: 'cmd:npm test', label: 'x' },
    };
    expect(
      await createPermissionPrompter({ keys: fakeKeys(key('escape')), out: sink().out, ask: async () => undefined, interactive: () => true })(cmd),
    ).toEqual({ allow: false });
  });

  it('"No, y decirle qué hacer distinto" devuelve la indicación', async () => {
    const { p } = prompter(fakeKeys(key('down'), key('down'), key('return')), '  usa otra función  ');
    expect(await p(edit)).toEqual({ allow: false, feedback: 'usa otra función' });
  });

  it('Esc rechaza sin preguntar nada más; sin terminal interactivo rechaza', async () => {
    const asked: string[] = [];
    const o = sink();
    const p = createPermissionPrompter({ keys: fakeKeys(key('escape')), out: o.out, ask: async (q) => (asked.push(q), 'x'), interactive: () => true });
    expect(await p(edit)).toEqual({ allow: false });
    expect(asked).toHaveLength(0);
    const keys = fakeKeys(key('return'));
    expect(await createPermissionPrompter({ keys, out: o.out, ask: async () => '', interactive: () => false })(edit)).toEqual({ allow: false });
    expect(keys.listens).toBe(0);
  });
});

describe('autorización con detalle', () => {
  const req: PermissionRequest = { kind: 'delete', title: 'Borrar', target: 'a.txt', question: '¿borrar?' };
  const perms = (over: Partial<Permissions>): Permissions => ({ autoApprove: false, allowedCommands: [], confirm: async () => false, ...over });

  it('deny gana siempre; allow y --yes no preguntan', async () => {
    let asked = 0;
    const p = perms({ confirm: async () => (asked++, true), autoApprove: true });
    expect(await authorizeDetailed(p, 'deny', req)).toEqual({ allow: false });
    expect(await authorizeDetailed(p, 'allow', req)).toEqual({ allow: true });
    expect(await authorizeDetailed(p, 'ask', req)).toEqual({ allow: true });
    expect(asked).toBe(0);
  });

  it('usa el diálogo si existe y, si no, el confirm de texto', async () => {
    expect(await authorizeDetailed(perms({ prompt: async () => ({ allow: false, feedback: 'no' }) }), 'ask', req)).toEqual({ allow: false, feedback: 'no' });
    expect(await authorizeDetailed(perms({ confirm: async () => true }), 'ask', req)).toEqual({ allow: true });
    expect(await authorizeDetailed(perms({}), 'ask', req)).toEqual({ allow: false });
  });

  it('el mensaje de rechazo incluye lo que pidió el usuario', () => {
    expect(denialMessage({ allow: false })).toBe('DENEGADO por el usuario.');
    expect(denialMessage({ allow: false, feedback: 'usa map' })).toBe('DENEGADO por el usuario. El usuario indica: usa map');
  });

  it('solo se ofrece recordar comandos simples dentro del proyecto', () => {
    expect(commandSessionKey('npm run build')?.key).toBe('cmd:npm run');
    expect(commandSessionKey('git commit -m x')?.key).toBe('cmd:git commit');
    expect(commandSessionKey('ls -la')?.key).toBe('cmd:ls');
    for (const bad of ['ls; rm x', 'cat a | sh', 'echo $(id)', 'cat ../x', 'cat /etc/passwd', 'cat ~/.ssh/id_rsa', 'cat .env', 'a && b']) {
      expect(commandSessionKey(bad), bad).toBeUndefined();
    }
  });
});

describe('decisiones del flujo', () => {
  const prompt = { title: 'Plan', approve: 'Sí', cancel: 'No', feedback: 'Cambios' };

  it('decide usa el diálogo cuando el flujo lo ofrece y --yes lo salta', async () => {
    let chosen = 0;
    const io: WorkflowIO = { say: () => {}, ask: async () => 'a', choose: async () => (chosen++, { kind: 'feedback', text: 'otra librería' }) };
    expect(await decide(io, 'q', false, prompt)).toEqual({ kind: 'feedback', text: 'otra librería' });
    expect(await decide(io, 'q', true, prompt)).toEqual({ kind: 'approve' });
    expect(chosen).toBe(1);
    const sinDialogo: WorkflowIO = { say: () => {}, ask: async () => 'x' };
    expect(await decide(sinDialogo, 'q', false, prompt)).toEqual({ kind: 'cancel' });
  });

  const dp = (keys: KeySource, answer?: string) => createDecisionPrompter({ keys, out: sink().out, ask: async () => answer, interactive: () => true });

  it('aprobar, cancelar y pedir cambios con el selector', async () => {
    expect(await dp(fakeKeys(key('return')))(prompt)).toEqual({ kind: 'approve' });
    expect(await dp(fakeKeys(key('down'), key('return')), 'usa otra')(prompt)).toEqual({ kind: 'feedback', text: 'usa otra' });
    expect(await dp(fakeKeys(key('down'), key('return')), '')(prompt)).toEqual({ kind: 'cancel' });
    expect(await dp(fakeKeys(['3', {}]))(prompt)).toEqual({ kind: 'cancel' });
    expect(await dp(fakeKeys(key('escape')))(prompt)).toEqual({ kind: 'cancel' });
  });

  it('sin la opción de cambios solo hay sí / no, y sin terminal cancela', async () => {
    const sin = { title: 'Push', approve: 'Sí', cancel: 'No' };
    expect(await dp(fakeKeys(['2', {}]))(sin)).toEqual({ kind: 'cancel' });
    expect(await createDecisionPrompter({ keys: fakeKeys(key('return')), out: sink().out, ask: async () => '', interactive: () => false })(sin)).toEqual({
      kind: 'cancel',
    });
  });
});

describe('presentación de la sesión', () => {
  it('nombra las herramientas en español y muestra su argumento principal', () => {
    expect(toolLabel('readFile', { filePath: 'src/a.js' })).toEqual({ name: 'Leer', arg: 'src/a.js' });
    expect(toolLabel('bash', { command: 'npm test', timeout: 5 })).toEqual({ name: 'Bash', arg: 'npm test' });
    expect(toolLabel('mcp__jira__create_issue', { title: 'x' }).name).toBe('jira:create_issue');
    expect(toolLabel('mcp__my_server__do_it', {}).name).toBe('my_server:do_it');
  });

  it('resume en una línea el resultado de cada herramienta', () => {
    expect(summarizeResult('readFile', { fromLine: 1, toLine: 4 })).toEqual({ text: 'Leídas 4 líneas', tone: 'plain' });
    expect(summarizeResult('editFile', { replacements: 1 })).toEqual({ text: 'Editado (1 reemplazo)', tone: 'ok' });
    expect(summarizeResult('grep', { matchCount: 3 }).text).toBe('3 coincidencias');
    expect(summarizeResult('bash', { exitCode: 0, stdout: 'ok\nmás', stderr: '' })).toEqual({ text: '✓ ok', tone: 'ok' });
    expect(summarizeResult('bash', { exitCode: 2, stdout: '', stderr: 'fallo' })).toEqual({ text: '✗ código 2 · fallo', tone: 'error' });
    expect(summarizeResult('writeFile', { error: 'DENEGADO por el usuario.' }).tone).toBe('denied');
    expect(summarizeResult('mcp__x__y', 'DENEGADO por el usuario. El usuario indica: no').tone).toBe('denied');
    expect(summarizeResult('writeFile', 'Error: DENEGADO por el usuario. El usuario indica: no')).toEqual({
      text: 'Error: DENEGADO por el usuario. El usuario indica: no',
      tone: 'denied',
    });
    expect(summarizeResult('mcp__x__y', { a: 1 }).text).toBe('{"a":1}');
    const mcp = (text: string) => ({ content: [{ type: 'text', text }] });
    expect(summarizeResult('mcp__t__list_issues', mcp('[{"key":"A-1"},{"key":"A-2"}]')).text).toBe('2 elementos');
    expect(summarizeResult('mcp__t__list_issues', mcp('[{"key":"A-1"}]')).text).toBe('1 elemento');
    expect(summarizeResult('mcp__t__get_issue', mcp('{"key":"A-1","title":"x"}')).text).toBe('{ key, title }');
    expect(summarizeResult('mcp__t__add_comment', mcp('comentado A-1\notra línea')).text).toBe('comentado A-1');
  });

  it('da formato inline de Markdown', () => {
    expect(stripAnsi(formatMarkdownLine('## Título'))).toBe('Título');
    expect(formatMarkdownLine('- uno **dos** `tres`')).toContain('• uno');
    expect(stripAnsi(formatMarkdownLine('- uno **dos** `tres`'))).toBe('• uno dos tres');
  });

  it('escribe el texto del asistente con viñeta ●, sangría y bloques de código', () => {
    const o = sink();
    const ui = new Ui(o.out);
    ui.text('Hola ');
    ui.text('mundo\n\n## Pasos\n- uno\n```js\nlet a');
    ui.text(' = 1;\n```\n');
    ui.endText();
    expect(stripAnsi(o.text())).toBe('● Hola mundo\n\n  Pasos\n  • uno\n  ```js\n  let a = 1;\n  ```\n');
  });

  it('muestra llamadas y resultados como ● Herramienta(arg) y ⎿ resumen', () => {
    const o = sink();
    const ui = new Ui(o.out);
    ui.text('Voy a leerlo');
    ui.toolCall('readFile', { filePath: 'a.js' });
    ui.toolResult('readFile', { fromLine: 1, toLine: 2 });
    ui.toolCall('todowrite', { todos: [] });
    ui.todos([
      { content: 'uno', status: 'completed' },
      { content: 'dos', status: 'in_progress' },
      { content: 'tres', status: 'pending' },
    ]);
    ui.toolResult('todowrite', { todos: [] });
    expect(stripAnsi(o.text())).toBe('● Voy a leerlo\n● Leer(a.js)\n  ⎿  Leídas 2 líneas\n● Tareas\n  ⎿  ☒ uno\n  ⎿  ◼ dos\n  ⎿  ☐ tres\n');
  });

  it('con varias llamadas en paralelo cada resultado dice a cuál pertenece', () => {
    const o = sink();
    const ui = new Ui(o.out);
    ui.toolCall('readFile', { filePath: 'a' });
    ui.toolCall('grep', { pattern: 'x' });
    ui.toolResult('grep', { matchCount: 1 });
    ui.toolResult('readFile', { fromLine: 1, toLine: 1 });
    const t = stripAnsi(o.text());
    expect(t).toContain('⎿  Buscar: 1 coincidencia');
    expect(t).toContain('⎿  Leídas 1 líneas');
  });
});

describe('interrupción', () => {
  it('Esc/Ctrl+C aborta el turno armado y quit() sale de la sesión', async () => {
    const { Interrupt } = await import('../src/ui/interrupt.js');
    const i = new Interrupt({ isTTY: false } as NodeJS.ReadStream);
    expect(i.fire()).toBe(false);
    let aborted = 0;
    const disarm = i.arm(() => aborted++);
    expect(i.fire()).toBe(true);
    disarm();
    expect(i.fire()).toBe(false);
    expect(aborted).toBe(1);
    expect(i.quit()).toBe(false);
    let left = 0;
    i.onQuit(() => left++);
    expect(i.quit()).toBe(true);
    expect(left).toBe(1);
  });
});

describe('flujo pedido en lenguaje natural (herramienta start_workflow)', () => {
  const run = (perms: Permissions, handlers: { work: (r: string) => Promise<void> }) =>
    (
      workflowTool(perms, { ...handlers, issues: async () => {}, ship: async () => {} }) as { execute: (i: { issue: string }, o: never) => Promise<string> }
    ).execute({ issue: 'PROJ-7' }, { toolCallId: 't', messages: [] } as never);

  it('pide permiso con el diálogo y solo entonces lanza el flujo', async () => {
    const seen: PermissionRequest[] = [];
    const refs: string[] = [];
    const ok: Permissions = { autoApprove: false, allowedCommands: [], confirm: async () => false, prompt: async (r) => (seen.push(r), { allow: true }) };
    expect(await run(ok, { work: async (r) => void refs.push(r) })).toContain('terminó');
    expect(refs).toEqual(['PROJ-7']);
    expect(seen[0]).toMatchObject({ kind: 'workflow', target: 'PROJ-7' });

    refs.length = 0;
    const no: Permissions = { ...ok, prompt: async () => ({ allow: false, feedback: 'primero el plan' }) };
    expect(await run(no, { work: async (r) => void refs.push(r) })).toBe('DENEGADO por el usuario. El usuario indica: primero el plan');
    expect(refs).toEqual([]);
  });

  it('si el flujo falla, el modelo recibe el error en lugar de romperse', async () => {
    const ok: Permissions = { autoApprove: true, allowedCommands: [], confirm: async () => true };
    expect(await run(ok, { work: async () => Promise.reject(new Error('no hay repo')) })).toBe('Error en el flujo: no hay repo');
  });
});

describe('colorizeDiff', () => {
  it('sin color (no es TTY) deja el diff intacto y con color pinta +/-', async () => {
    const { colorizeDiff, stripAnsi } = await import('../src/ui/ansi.js');
    const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-viejo\n+nuevo\n igual';
    expect(colorizeDiff(patch)).toBe(patch); // vitest no es TTY
    expect(stripAnsi(colorizeDiff(patch))).toBe(patch);
  });
});

describe('medidor de contexto', () => {
  it('la barra se llena según el porcentaje y respeta los extremos', async () => {
    const { contextBar, stripAnsi } = await import('../src/ui/ansi.js');
    expect(stripAnsi(contextBar(0, 75))).toBe('▱▱▱▱▱▱▱▱▱▱');
    expect(stripAnsi(contextBar(50, 75))).toBe('▰▰▰▰▰▱▱▱▱▱');
    expect(stripAnsi(contextBar(100, 75))).toBe('▰▰▰▰▰▰▰▰▰▰');
    expect(stripAnsi(contextBar(250, 75))).toBe('▰▰▰▰▰▰▰▰▰▰'); // nunca se desborda
  });
  it('la regla del prompt incluye el medidor sin pasarse del ancho', () => {
    const lines: string[] = [];
    const ui = new Ui({ write: (s: string) => lines.push(s), isTTY: false } as never);
    const rule = stripAnsi(ui.rule('modo: preguntar antes de cambiar · Shift+Tab cambia', 'ctx ▰▰▱▱▱▱▱▱▱▱ 21 %'));
    expect(rule).toContain('· ctx ▰▰▱▱▱▱▱▱▱▱ 21 %');
    expect(visibleWidth(rule)).toBeLessThanOrEqual(100);
  });
});
