import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, McpServerSchema } from '../src/config.js';
import { type ConnectDeps, connectionHint, connectTracker, keyInstructions, loginProvider } from '../src/connect/connect.js';
import { findPreset, isReadOnlyTool, mergeServer, originalToolName, PRESETS, splitTools } from '../src/connect/presets.js';
import { applyCredentials, maskSecret, parseCredentials, saveCredential } from '../src/credentials.js';
import type { McpConnections, McpServerStatus } from '../src/mcp/client.js';
import { checkApiKey } from '../src/providers.js';
import { stripAnsi } from '../src/ui/ansi.js';
import { Ui } from '../src/ui/render.js';
import { readSecret } from '../src/ui/secret.js';
import type { Key, KeySource } from '../src/ui/select.js';
import type { DecisionPrompt, Reply } from '../src/workflow/run.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

/** Teclas simuladas: escribe texto carácter a carácter y pulsa Enter, como una persona. */
function typing(text: string, ...after: [string | undefined, Key][]): KeySource {
  return {
    listen(handler) {
      let on = true;
      (async () => {
        for (const ch of text) {
          await new Promise((r) => setImmediate(r));
          if (on) handler(ch, { sequence: ch });
        }
        for (const [s, k] of after.length ? after : [[undefined, { name: 'return' }] as [string | undefined, Key]]) {
          await new Promise((r) => setImmediate(r));
          if (on) handler(s, k);
        }
      })();
      return () => {
        on = false;
      };
    },
  };
}
const sink = () => {
  const chunks: string[] = [];
  return { out: { write: (s: string) => chunks.push(s) }, text: () => stripAnsi(chunks.join('')) };
};

describe('credenciales fuera del repositorio', () => {
  it('guarda con permisos privados, actualiza sin duplicar y valida el nombre', async () => {
    const file = join(tmp('cred-'), 'sub', 'credentials');
    await saveCredential('JIRA_API_TOKEN', 'abc=123', file);
    await saveCredential('TRELLO_TOKEN', 'xyz', file);
    await saveCredential('JIRA_API_TOKEN', 'nuevo', file);
    expect(parseCredentials(readFileSync(file, 'utf8'))).toEqual({ JIRA_API_TOKEN: 'nuevo', TRELLO_TOKEN: 'xyz' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await expect(saveCredential('MAL NOMBRE', 'x', file)).rejects.toThrow(/inválido/);
    await expect(saveCredential('OK', 'a\nb', file)).rejects.toThrow(/saltos/);
    await expect(saveCredential('OK', '  ', file)).rejects.toThrow();
  });

  it('lo exportado en el entorno manda; el archivo solo rellena lo que falta', async () => {
    const file = join(tmp('cred-'), 'credentials');
    await saveCredential('A', 'del-archivo', file);
    await saveCredential('B', 'del-archivo', file);
    const env: NodeJS.ProcessEnv = { A: 'del-entorno' };
    expect(await applyCredentials(env, file)).toEqual(['B']);
    expect(env).toEqual({ A: 'del-entorno', B: 'del-archivo' });
    expect(await applyCredentials({}, join(tmp('x-'), 'no-existe'))).toEqual([]);
  });

  it('enmascara el secreto', () => {
    expect(maskSecret('ghp_abcdefghijkl')).toBe('••••ijkl');
    expect(maskSecret('corto')).toBe('••••');
  });
});

describe('lectura de secretos sin eco', () => {
  it('no muestra lo escrito, admite borrar y devuelve el valor', async () => {
    const o = sink();
    const keys: KeySource = typing('abcX', [undefined, { name: 'backspace' }], [undefined, { name: 'return' }]);
    expect(await readSecret('token: ', { keys, out: o.out })).toBe('abc');
    expect(o.text()).toContain('token: ');
    expect(o.text()).not.toContain('abc');
    expect(o.text()).toContain('••••');
  });

  it('Esc cancela', async () => {
    expect(await readSecret('t: ', { keys: typing('abc', [undefined, { name: 'escape' }]), out: sink().out })).toBeUndefined();
  });
});

describe('presets y herramientas de lectura', () => {
  it('los tres presets generan configuración válida sin secretos dentro', () => {
    const jira = findPreset('JIRA')!.build({ site: 'acme', email: 'a@b.c' });
    expect(jira.env).toEqual({ ATLASSIAN_SITE_NAME: 'acme', ATLASSIAN_USER_EMAIL: 'a@b.c', ATLASSIAN_API_TOKEN: '${JIRA_API_TOKEN}' });
    const trello = findPreset('trello')!.build({ boardId: 'B1' });
    expect(trello.env).toMatchObject({ TRELLO_API_KEY: '${TRELLO_API_KEY}', TRELLO_TOKEN: '${TRELLO_TOKEN}', TRELLO_BOARD_ID: 'B1' });
    expect(findPreset('trello')!.build({}).env).not.toHaveProperty('TRELLO_BOARD_ID');
    const gh = findPreset('github')!.build({});
    expect(gh).toEqual({ url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } });
    for (const p of PRESETS) {
      expect(() => McpServerSchema.parse(p.build({ site: 's', email: 'e' }))).not.toThrow();
      expect(JSON.stringify(p.build({ site: 's', email: 'e' }))).not.toMatch(/ghp_|[A-Za-z0-9]{32,}/);
    }
  });

  it('distingue herramientas de lectura de las de escritura, con la duda hacia escribir', () => {
    for (const r of ['jira_get', 'jira_ls_issues', 'get_cards_by_list_id', 'list_boards', 'search_issues', 'read_file', 'whoami'])
      expect(isReadOnlyTool(r), r).toBe(true);
    for (const w of [
      'jira_post',
      'jira_put',
      'jira_patch',
      'jira_delete',
      'add_card_to_list',
      'create_issue',
      'update_card',
      'move_card',
      'get_and_delete',
      'archive_card',
      'unknown_tool',
    ]) {
      expect(isReadOnlyTool(w), w).toBe(false);
    }
  });

  it('separa las herramientas expuestas por servidor', () => {
    expect(originalToolName('mcp__jira__jira_get', 'jira')).toBe('jira_get');
    expect(splitTools(['mcp__jira__jira_get', 'mcp__jira__jira_post', 'mcp__jira__jira_ls_issues'], 'jira')).toEqual({
      read: ['jira_get', 'jira_ls_issues'],
      write: ['jira_post'],
    });
  });

  it('mergeServer conserva el resto de la configuración y reemplaza el servidor', () => {
    const base = JSON.stringify({ model: 'x/y', mcpServers: { otro: { command: 'a' }, jira: { command: 'viejo' } } });
    const out = JSON.parse(mergeServer(base, 'jira', { command: 'nuevo', autoApprove: ['jira_get'] }));
    expect(out.model).toBe('x/y');
    expect(out.mcpServers.otro).toEqual({ command: 'a' });
    expect(out.mcpServers.jira).toEqual({ command: 'nuevo', autoApprove: ['jira_get'] });
    expect(JSON.parse(mergeServer(undefined, 'github', { url: 'u' }))).toEqual({ mcpServers: { github: { url: 'u' } } });
    expect(() => mergeServer('[1]', 'x', {})).toThrow(/objeto/);
  });
});

describe('configuración global', () => {
  it('mezcla la global con la del proyecto: el proyecto manda y los objetos se combinan', async () => {
    const dir = tmp('cfg-');
    const global = join(dir, 'global.json');
    writeFileSync(global, JSON.stringify({ model: 'google/a', roles: { plan: 'google/p' }, mcpServers: { jira: { command: 'g' }, otro: { command: 'o' } } }));
    writeFileSync(join(dir, 'agente.config.json'), JSON.stringify({ model: 'anthropic/b', mcpServers: { jira: { command: 'p' } } }));
    const cfg = await loadConfig(dir, global);
    expect(cfg.model).toBe('anthropic/b');
    expect(cfg.roles.plan).toBe('google/p');
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(['jira', 'otro']);
    expect(cfg.mcpServers.jira?.command).toBe('p');
    expect(cfg.mcpServers.otro?.command).toBe('o');
  });

  it('funciona sin ninguno de los dos archivos', async () => {
    expect((await loadConfig(tmp('cfg-'), join(tmp('nada-'), 'no-existe.json'))).mcpServers).toEqual({});
  });
});

describe('/connect: flujo guiado', () => {
  const fakeMcp = (result: McpServerStatus) => {
    const added: Record<string, unknown>[] = [];
    const mcp = {
      tools: {},
      status: [],
      close: async () => {},
      add: async (s: Record<string, unknown>) => (added.push(s), [result]),
    } as unknown as McpConnections;
    return { mcp, added };
  };

  const deps = async (o: { keys: KeySource; mcp: McpConnections; answers?: string[]; choices?: Reply[]; env?: NodeJS.ProcessEnv }) => {
    const cwd = tmp('proj-');
    const asked: DecisionPrompt[] = [];
    const sk = sink();
    const d: ConnectDeps = {
      cwd,
      ui: new Ui(sk.out),
      rl: { question: async () => o.answers?.shift() ?? '' },
      keys: o.keys,
      out: sk.out,
      choose: async (p) => (asked.push(p), o.choices?.shift() ?? { kind: 'approve' }),
      mcp: o.mcp,
      config: await loadConfig(cwd),
      credFile: join(tmp('cred-'), 'credentials'),
      configFile: join(cwd, 'agente.config.json'),
      env: o.env ?? {},
    };
    return { d, cwd, asked, sk };
  };

  const ok: McpServerStatus = { name: 'jira', ok: true, tools: ['mcp__jira__jira_get', 'mcp__jira__jira_post', 'mcp__jira__jira_ls_issues'] };

  it('Jira: pide datos, guarda el token aparte, prueba, marca solo lo de lectura y escribe la configuración sin secretos', async () => {
    const { mcp, added } = fakeMcp(ok);
    const { d, cwd, asked, sk } = await deps({ keys: typing('tok_secreto_1234'), mcp, answers: ['acme', 'yo@acme.com'] });
    expect(await connectTracker(d, 'jira')).toBe(true);

    expect(parseCredentials(readFileSync(d.credFile!, 'utf8'))).toEqual({ JIRA_API_TOKEN: 'tok_secreto_1234' });
    expect(d.env!.JIRA_API_TOKEN).toBe('tok_secreto_1234');
    const cfgText = readFileSync(join(cwd, 'agente.config.json'), 'utf8');
    expect(cfgText).not.toContain('tok_secreto_1234');
    const cfg = JSON.parse(cfgText).mcpServers.jira;
    expect(cfg.env).toEqual({ ATLASSIAN_SITE_NAME: 'acme', ATLASSIAN_USER_EMAIL: 'yo@acme.com', ATLASSIAN_API_TOKEN: '${JIRA_API_TOKEN}' });
    expect(cfg.autoApprove).toEqual(['jira_get', 'jira_ls_issues']);
    expect(asked[0]?.detail).toEqual(['jira_get', 'jira_ls_issues']);
    expect((added[0]!.jira as { autoApprove: string[] }).autoApprove).toEqual(['jira_get', 'jira_ls_issues']); // la conexión viva también
    expect(sk.text()).toContain('Conectar Jira');
    expect(sk.text()).toContain('/issues');
    expect(sk.text()).not.toContain('tok_secreto_1234');
  });

  it('si el usuario prefiere que pregunte siempre, no se guarda autoApprove', async () => {
    const { mcp } = fakeMcp(ok);
    const { d, cwd } = await deps({ keys: typing('t0k3n'), mcp, answers: ['acme', 'a@b.c'], choices: [{ kind: 'cancel' }] });
    await connectTracker(d, 'jira');
    expect(JSON.parse(readFileSync(join(cwd, 'agente.config.json'), 'utf8')).mcpServers.jira).not.toHaveProperty('autoApprove');
  });

  it('usa un secreto que ya está en el entorno sin pedirlo', async () => {
    const { mcp } = fakeMcp({ ...ok, name: 'github', tools: [] });
    const { d, sk } = await deps({ keys: typing('NO-DEBE-LEERSE'), mcp, env: { GITHUB_TOKEN: 'del-entorno' } });
    expect(await connectTracker(d, 'github')).toBe(true);
    expect(sk.text()).toContain('ya está en tu entorno');
    expect(() => readFileSync(d.credFile!, 'utf8')).toThrow(); // no se guardó nada
  });

  it('si la conexión falla explica por qué y solo guarda si se confirma', async () => {
    const bad: McpServerStatus = { name: 'jira', ok: false, tools: [], error: 'HTTP 401 Unauthorized' };
    const { mcp } = fakeMcp(bad);
    const a = await deps({ keys: typing('malo'), mcp, answers: ['acme', 'a@b.c'], choices: [{ kind: 'cancel' }] });
    expect(await connectTracker(a.d, 'jira')).toBe(false);
    expect(a.sk.text()).toContain('credenciales');
    expect(() => readFileSync(join(a.cwd, 'agente.config.json'), 'utf8')).toThrow(); // no se guardó la configuración

    const b = await deps({ keys: typing('malo'), mcp, answers: ['acme', 'a@b.c'], choices: [{ kind: 'approve' }] });
    expect(await connectTracker(b.d, 'jira')).toBe(false);
    expect(JSON.parse(readFileSync(join(b.cwd, 'agente.config.json'), 'utf8')).mcpServers.jira.command).toBe('npx');
  });

  it('cancelar la clave o dejar un dato obligatorio vacío no configura nada', async () => {
    const { mcp, added } = fakeMcp(ok);
    const a = await deps({ keys: typing('x', [undefined, { name: 'escape' }]), mcp, answers: ['acme', 'a@b.c'] });
    expect(await connectTracker(a.d, 'jira')).toBe(false);
    const b = await deps({ keys: typing('x'), mcp, answers: [''] });
    expect(await connectTracker(b.d, 'jira')).toBe(false);
    expect(added).toEqual([]);
  });

  it('un tracker desconocido lista las opciones', async () => {
    const { mcp } = fakeMcp(ok);
    const { d, sk } = await deps({ keys: typing(''), mcp });
    expect(await connectTracker(d, 'asana')).toBe(false);
    expect(sk.text()).toContain('jira, trello, github');
  });

  it('da pistas según el error', () => {
    expect(connectionHint('HTTP 403 Forbidden')).toContain('credenciales');
    expect(connectionHint('Tiempo de espera agotado (60s)')).toContain('descarga');
    expect(connectionHint('spawn npx ENOENT')).toContain('npx');
  });
});

describe('primera ejecución: clave del modelo', () => {
  const base = async (keys: KeySource, fetchImpl: typeof fetch, choices: Reply[] = []) => {
    const cwd = tmp('login-');
    const sk = sink();
    const d: ConnectDeps = {
      cwd,
      ui: new Ui(sk.out),
      rl: { question: async () => '' },
      keys,
      out: sk.out,
      choose: async () => choices.shift() ?? { kind: 'approve' },
      mcp: {} as McpConnections,
      config: await loadConfig(cwd),
      credFile: join(tmp('cred-'), 'credentials'),
      env: {},
      fetchImpl,
    };
    return { d, sk };
  };
  const status = (code: number) => (async () => new Response('{}', { status: code })) as typeof fetch;

  it('explica cómo conseguir la clave de cada proveedor', async () => {
    const config = await loadConfig(tmp('cfg-'));
    expect(keyInstructions('google/gemini-3.5-flash-lite', config)).toContain('https://aistudio.google.com/apikey');
    expect(keyInstructions('google/x', config)).toContain('GOOGLE_GENERATIVE_AI_API_KEY');
    expect(keyInstructions('anthropic/x', config)).toContain('console.anthropic.com');
    expect(keyInstructions('ollama/x', config)).toContain('ollama pull');
  });

  it('comprueba la clave, la guarda con la variable correcta y confirma sin mostrarla', async () => {
    const { d, sk } = await base(typing('AIza-secreta-9999'), status(200));
    expect(await loginProvider(d, 'google/gemini-3.5-flash-lite')).toBe(true);
    expect(parseCredentials(readFileSync(d.credFile!, 'utf8'))).toEqual({ GOOGLE_GENERATIVE_AI_API_KEY: 'AIza-secreta-9999' });
    expect(d.env!.GOOGLE_GENERATIVE_AI_API_KEY).toBe('AIza-secreta-9999');
    expect(sk.text()).toContain('Clave válida');
    expect(sk.text()).not.toContain('AIza-secreta-9999');
  });

  it('una clave rechazada no se guarda salvo que se insista; sin red se guarda igualmente', async () => {
    const a = await base(typing('mala'), status(401), [{ kind: 'cancel' }]);
    expect(await loginProvider(a.d, 'google/x')).toBe(false);
    expect(() => readFileSync(a.d.credFile!, 'utf8')).toThrow();

    const b = await base(typing('mala'), status(400), [{ kind: 'approve' }]);
    expect(await loginProvider(b.d, 'google/x')).toBe(true);

    const c = await base(typing('okkey'), (async () => Promise.reject(new Error('sin red'))) as typeof fetch);
    expect(await loginProvider(c.d, 'anthropic/x')).toBe(true);
    expect(c.sk.text()).toContain('no pude comprobarla');
  });

  it('Ollama no usa clave: solo da instrucciones', async () => {
    const { d, sk } = await base(typing(''), status(200));
    expect(await loginProvider(d, 'ollama/qwen')).toBe(false);
    expect(sk.text()).toContain('ollama serve');
  });

  it('checkApiKey usa la cabecera correcta de cada proveedor', async () => {
    const seen: Record<string, string>[] = [];
    const f = (async (_u: string, init: RequestInit) => (seen.push(init.headers as Record<string, string>), new Response('{}'))) as unknown as typeof fetch;
    expect(await checkApiKey('google', 'K', f)).toBe('valid');
    expect(await checkApiKey('anthropic', 'K', f)).toBe('valid');
    expect(await checkApiKey('openai', 'K', f)).toBe('valid');
    expect(seen[0]).toMatchObject({ 'x-goog-api-key': 'K' });
    expect(seen[1]).toMatchObject({ 'x-api-key': 'K', 'anthropic-version': '2023-06-01' });
    expect(seen[2]).toMatchObject({ authorization: 'Bearer K' });
    expect(await checkApiKey('ollama', 'K', f)).toBe('unknown');
  });
});
