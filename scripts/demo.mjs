// Demostración sin red ni claves: un modelo simulado local responde y el arnés muestra el subagente en acción.
// Uso: npm run demo
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
let n = 0;
const call = (name, args) => ({ id: `c${++n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const text = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));

function respond(msgs) {
  const esSubagente = text(msgs[0]).includes('subagente de investigación');
  const herramientas = msgs.filter((m) => m.role === 'tool').length;
  if (esSubagente) {
    return herramientas === 0
      ? { tool_calls: [call('readFile', { filePath: 'src/math.js' })] }
      : { content: 'src/math.js define add(a, b) y average(numbers); average no valida el arreglo vacío.' };
  }
  if (msgs.at(-1).role === 'tool') return { content: 'Según el subagente: average divide entre numbers.length sin validar el arreglo vacío.' };
  return { tool_calls: [call('delegate', { task: 'Investiga cómo está implementada average en src/math.js' })] };
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const out = respond(JSON.parse(body).messages);
    const chunk = (delta, fin = null) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta, finish_reason: fin }] })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (out.tool_calls) {
      out.tool_calls.forEach((c, i) => res.write(chunk({ role: 'assistant', tool_calls: [{ index: i, ...c }] })));
      res.write(chunk({}, 'tool_calls'));
    } else {
      res.write(chunk({ role: 'assistant', content: out.content }));
      res.write(chunk({}, 'stop'));
    }
    res.end('data: [DONE]\n\n');
  });
});

await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;
const dir = mkdtempSync(join(tmpdir(), 'agente-demo-'));
mkdirSync(join(dir, 'src'));
writeFileSync(join(dir, 'src', 'math.js'), 'export const add = (a, b) => a + b;\nexport const average = (n) => n.reduce((s, x) => s + x, 0) / n.length;\n');
writeFileSync(join(dir, 'agente.config.json'), JSON.stringify({ model: 'local/demo', providers: { local: { baseURL: `http://127.0.0.1:${port}/v1` } } }));

console.log('Demo sin red: "investiga average" → el modelo delega en un subagente de solo lectura\n');
const child = spawn(process.execPath, [cli, '-p', 'investiga average', '--yes'], {
  cwd: dir,
  stdio: 'inherit',
  env: { ...process.env, AGENTE_HOME: join(dir, '.home') },
});
const code = await new Promise((ok) => child.on('close', ok));
server.close();
process.exit(code ?? 1);
