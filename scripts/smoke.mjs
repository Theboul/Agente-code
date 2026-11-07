#!/usr/bin/env node
// Prueba de humo: ejecuta el binario compilado (dist/cli.js) en un proyecto temporal con un modelo simulado
// y comprueba el flujo completo: plan → rama → implementación → verificación (falla y se corrige) → commit → push.
// No necesita red ni claves. Funciona igual en Linux, macOS y Windows (solo usa Node y git).
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist', 'cli.js');
const TIMEOUT_MS = 120_000;

// ── Modelo simulado (API compatible con OpenAI, en streaming) ───────────────────────────────────────────
let callId = 0;
const call = (name, args) => ({ id: `call_${++callId}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const BUGGY = 'export function add(a, b) {\n  return a + b;\n}\n\nexport function average(numbers) {\n  return numbers.reduce((s, n) => s + n, 0) / numbers.length;\n}';
const TESTS = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { add, average } from '../src/math.js';",
  '',
  "test('add suma', () => {",
  '  assert.equal(add(2, 3), 5);',
  '});',
  '',
  "test('average promedia', () => {",
  '  assert.equal(average([2, 4, 6]), 4);',
  '});',
  '',
  "test('average lanza si está vacío', () => {",
  '  assert.throws(() => average([]), /vacío/);',
  '});',
  '',
].join('\n');

const text = (content) => ({ content });
const tools = (...c) => ({ tool_calls: c });
const content = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));

function respond(msgs) {
  const lastUser = msgs.map((m) => m.role).lastIndexOf('user');
  const u = content(msgs[lastUser]);
  const rounds = msgs.slice(lastUser).filter((m) => m.role === 'assistant' && m.tool_calls).length;
  if (u.includes('mensaje de commit')) return text('feat(math): añade average con validación\n\nCalcula el promedio y lanza un Error si no hay elementos.\n\nCo-Authored-By: Modelo <modelo@example.com>');
  if (u.includes('descripción (cuerpo)')) return text('## Resumen\nAñade average.\n\n🤖 Generated with Modelo');
  if (u.includes('PLANIFICAR')) return rounds === 0 ? tools(call('readFile', { filePath: 'src/math.js' })) : text('## Plan\n1. Implementar average.\n2. Añadir pruebas.\n3. Ejecutar npm test.');
  if (u.includes('verificación automática falló')) {
    if (rounds === 0) return tools(call('readFile', { filePath: 'src/math.js' }));
    if (rounds === 1) {
      const newString = "export function average(numbers) {\n  if (numbers.length === 0) {\n    throw new Error('Arreglo vacío');\n  }\n  return";
      return tools(call('editFile', { filePath: 'src/math.js', oldString: 'export function average(numbers) {\n  return', newString, replaceAll: false }));
    }
    return text('Corregido.');
  }
  if (u.includes('Implementa esta tarea')) {
    if (rounds === 0) return tools(call('readFile', { filePath: 'src/math.js' }));
    if (rounds === 1) return tools(call('editFile', { filePath: 'src/math.js', oldString: 'export function add(a, b) {\n  return a + b;\n}', newString: BUGGY, replaceAll: false }));
    if (rounds === 2) return tools(call('writeFile', { filePath: 'test/math.test.js', content: TESTS }));
    return text('Implementado. Falta correr la suite.');
  }
  return text('(sin guion para este mensaje)');
}

function startModel() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const out = respond(JSON.parse(body).messages);
      const chunk = (delta, fin = null) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'sim', choices: [{ index: 0, delta, finish_reason: fin }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (out.tool_calls) {
        out.tool_calls.forEach((c, i) => res.write(chunk({ role: 'assistant', tool_calls: [{ index: i, ...c }] })));
        res.write(chunk({}, 'tool_calls'));
      } else {
        for (const part of out.content.match(/[\s\S]{1,24}/g)) res.write(chunk({ role: 'assistant', content: part }));
        res.write(chunk({}, 'stop'));
      }
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

// ── Utilidades ──────────────────────────────────────────────────────────────────────────────────────
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} falló: ${r.stderr}`);
  return r.stdout.trim();
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `\n    ${detail}` : ''}`);
};

// ── Escenario ───────────────────────────────────────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'agente-smoke-'));
const server = await startModel();
let output = '';
let exitCode = -1;
try {
  if (!(spawnSync(process.execPath, ['-e', '0']).status === 0)) throw new Error('Node no responde');
  const proj = join(work, 'proj');
  const origin = join(work, 'origin.git');
  mkdirSync(join(proj, 'src'), { recursive: true });
  mkdirSync(join(proj, 'test'));
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'smoke', type: 'module', scripts: { test: 'node --test' } }));
  writeFileSync(join(proj, 'src', 'math.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
  writeFileSync(join(proj, 'test', 'math.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n\ntest('add suma', () => {\n  assert.equal(add(2, 3), 5);\n});\n");
  writeFileSync(join(proj, 'agente.config.json'), JSON.stringify({ model: 'sim/m', providers: { sim: { baseURL: `http://127.0.0.1:${server.address().port}/v1` } } }));
  mkdirSync(origin);
  git(origin, 'init', '--bare');
  git(proj, 'init');
  git(proj, 'checkout', '-b', 'main');
  git(proj, 'config', 'user.email', 'smoke@example.com');
  git(proj, 'config', 'user.name', 'Smoke');
  git(proj, 'add', '-A');
  git(proj, 'commit', '-m', 'estado inicial');
  git(proj, 'remote', 'add', 'origin', origin);
  git(proj, 'push', '-u', 'origin', 'main');

  const env = { ...process.env, AGENTE_HOME: join(work, 'home'), NO_COLOR: '1' };
  for (const k of ['GOOGLE_GENERATIVE_AI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete env[k];

  console.log('Ejecutando: agente work … --yes --ship (modelo simulado)\n');
  const child = spawn(process.execPath, [cli, 'work', 'Añadir average(numbers) a src/math.js que lance un Error si el arreglo está vacío, con pruebas', '--yes', '--ship'], { cwd: proj, env });
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
  exitCode = await new Promise((ok) => child.on('close', (code) => ok(code ?? -1)));
  clearTimeout(timer);

  const branches = git(origin, 'branch', '--list', 'feat/*');
  const branch = branches.replace('*', '').trim();
  check('el programa termina sin errores', exitCode === 0, `código de salida ${exitCode}`);
  check('el plan se genera', output.includes('Plan'));
  check('la verificación falla y el modelo la corrige', output.includes('Falló') && output.includes('Verificación correcta'));
  check('la rama llega al remoto', Boolean(branch), 'no hay ramas feat/* en el remoto');
  if (branch) {
    const msg = git(origin, 'log', '-1', '--format=%B', branch);
    check('el commit tiene el mensaje del modelo', msg.startsWith('feat(math)'), msg);
    check('el commit NO lleva coautor ni atribuciones', !/co-authored-by|generated with|claude-session/i.test(msg), msg);
    check('el autor es el del git del usuario', git(origin, 'log', '-1', '--format=%an <%ae>', branch) === 'Smoke <smoke@example.com>');
    git(proj, 'checkout', branch);
    const tests = spawnSync(process.execPath, ['--test'], { cwd: proj, encoding: 'utf8' });
    check('las pruebas del proyecto pasan en la rama entregada', tests.status === 0, tests.stdout + tests.stderr);
    check('el código tiene la validación del arreglo vacío', readFileSync(join(proj, 'src', 'math.js'), 'utf8').includes('length === 0'));
  }
} catch (e) {
  check('el escenario se ejecuta sin excepciones', false, String(e?.stack ?? e));
} finally {
  server.close();
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r).length;
if (failed) {
  console.log(`\n${failed} de ${results.length} comprobaciones fallaron. Salida del programa:\n${'─'.repeat(60)}\n${output}`);
  process.exit(1);
}
console.log(`\nTodo en orden: ${results.length} de ${results.length} comprobaciones.`);
