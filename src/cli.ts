#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import type { ModelMessage } from 'ai';
import { buildSystemPrompt } from './agent/system.js';
import { runTurn } from './agent/loop.js';
import { loadConfig, modelFor, ROLES, type Role } from './config.js';
import type { Permissions } from './permissions.js';
import { missingKeyHint, resolveModel } from './providers.js';
import { nativeTools } from './tools/index.js';

const HELP = `agente — arnés de código multi-modelo

Uso:
  agente [chat] [opciones]       Sesión interactiva en el directorio actual
  agente -p "prompt" [opciones]  Un solo turno y salir

Opciones:
  -m, --model <prov/modelo>   Modelo (ej. google/gemini-flash-latest, anthropic/…, openai/…, ollama/…)
  -r, --role <rol>            Usa el modelo configurado para el rol: ${ROLES.join(' | ')}
  -p, --prompt <texto>        Modo no interactivo
  -y, --yes                   Aprobar ediciones y comandos sin preguntar
  -h, --help

Dentro del chat: /model <prov/modelo>, /role <rol>, /clear, /exit
Config: agente.config.json en el proyecto (ver README).`;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const short = (v: unknown, n = 160) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
};

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: 'string', short: 'm' },
      role: { type: 'string', short: 'r' },
      prompt: { type: 'string', short: 'p' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return console.log(HELP);
  const cmd = positionals[0] ?? 'chat';
  if (cmd !== 'chat') {
    console.error(`Comando desconocido: ${cmd}\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const interactive = process.stdin.isTTY && values.prompt === undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const perms: Permissions = {
    autoApprove: values.yes ?? false,
    allowedCommands: config.allowedCommands,
    confirm: async (q) => {
      if (!process.stdin.isTTY) return false;
      const a = await rl.question(`\n${q}\n[s/N] `);
      return /^(s|si|sí|y|yes)$/i.test(a.trim());
    },
  };

  let modelId = values.model ?? modelFor(config, (values.role as Role | undefined) ?? 'implement');
  const system = await buildSystemPrompt(cwd);
  const tools = nativeTools(cwd, perms);
  let history: ModelMessage[] = [];

  const turn = async (input: string) => {
    const hint = missingKeyHint(modelId, config);
    if (hint) throw new Error(`Falta la variable de entorno ${hint} para usar ${modelId}.`);
    history.push({ role: 'user', content: input });
    const ac = new AbortController();
    const onSigint = () => ac.abort();
    process.once('SIGINT', onSigint);
    try {
      const { newMessages } = await runTurn({
        model: resolveModel(modelId, config),
        system,
        tools,
        messages: history,
        maxSteps: config.maxSteps,
        abortSignal: ac.signal,
        onText: (d) => process.stdout.write(d),
        onToolCall: (n, i) => console.log(dim(`\n⚙ ${n} ${short(i)}`)),
        onToolResult: (n, o) => console.log(dim(`  ↳ ${short(o, 200)}`)),
      });
      history.push(...newMessages);
      console.log();
    } catch (e) {
      history.pop();
      if (ac.signal.aborted) console.log(dim('\n(interrumpido)'));
      else console.error(`\nError: ${e instanceof Error ? e.message : e}`);
    } finally {
      process.off('SIGINT', onSigint);
    }
  };

  if (values.prompt !== undefined) {
    await turn(values.prompt);
    rl.close();
    return;
  }

  console.log(`agente · ${modelId} · ${cwd}\n${dim('/model, /role, /clear, /exit')}`);
  rl.on('SIGINT', () => {});
  for (;;) {
    let line: string;
    try {
      line = (await rl.question('\n› ')).trim();
    } catch {
      break; // stdin cerrado
    }
    if (!line) continue;
    if (line === '/exit' || line === '/salir') break;
    if (line === '/clear') {
      history = [];
      console.log(dim('Historial limpiado.'));
    } else if (line.startsWith('/model ')) {
      modelId = line.slice(7).trim();
      console.log(dim(`Modelo: ${modelId}`));
    } else if (line.startsWith('/role ')) {
      const r = line.slice(6).trim() as Role;
      if (!ROLES.includes(r)) console.log(`Rol inválido. Opciones: ${ROLES.join(', ')}`);
      else {
        modelId = modelFor(config, r);
        console.log(dim(`Modelo (${r}): ${modelId}`));
      }
    } else await turn(line);
  }
  void interactive;
  rl.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
