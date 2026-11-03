import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CONFIG_FILE, type Config, globalConfigFile, McpServerSchema } from '../config.js';
import { credentialsFile, maskSecret, saveCredential } from '../credentials.js';
import type { McpConnections } from '../mcp/client.js';
import { checkApiKey, DEFAULT_KEY_ENV, PROVIDER_HELP, parseModelId } from '../providers.js';
import { c, termWidth } from '../ui/ansi.js';
import { box, wrapText } from '../ui/box.js';
import type { Ui } from '../ui/render.js';
import { readSecret } from '../ui/secret.js';
import { type KeySource, selectIndex } from '../ui/select.js';
import type { DecisionPrompt, Reply } from '../workflow/run.js';
import { findPreset, mergeServer, PRESETS, type Preset, splitTools } from './presets.js';

export interface ConnectDeps {
  cwd: string;
  ui: Ui;
  rl: { question(q: string): Promise<string> };
  keys: KeySource;
  out: { write(chunk: string): unknown };
  choose: (p: DecisionPrompt) => Promise<Reply>;
  mcp: McpConnections;
  config: Config;
  presets?: Preset[];
  credFile?: string;
  /** Dónde se escribe el servidor. Por defecto la configuración global (~/.agente/config.json): conectas una vez y sirve en todos tus proyectos. */
  configFile?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

const CONNECT_TIMEOUT_MS = 60_000; // la primera vez npx descarga el paquete

/** Pista concreta según el error de conexión. */
export function connectionHint(error: string): string {
  if (/401|403|unauthori[sz]ed|forbidden|credential/i.test(error)) return 'Parece un problema de credenciales: revisa el token y el email.';
  if (/tiempo de espera|timeout|timed out/i.test(error)) return 'La primera vez npx descarga el paquete y puede tardar: vuelve a ejecutar /connect.';
  if (/ENOENT|not found|command/i.test(error)) return 'No se pudo lanzar el servidor: comprueba que Node y npx funcionan en esta terminal.';
  return 'Revisa los datos y vuelve a intentarlo con /connect.';
}

/** Conexión guiada a un tracker: pide las credenciales, las guarda fuera del repo, prueba la conexión y deja la configuración lista. */
export async function connectTracker(d: ConnectDeps, which?: string): Promise<boolean> {
  const { ui, rl, keys, out, mcp } = d;
  const presets = d.presets ?? PRESETS;
  const env = d.env ?? process.env;
  const credFile = d.credFile ?? credentialsFile();

  let preset = findPreset(which, presets);
  if (which && !preset) {
    ui.warn(`No conozco "${which}". Opciones: ${presets.map((p) => p.id).join(', ')}`);
    return false;
  }
  if (!preset) {
    const choice = await selectIndex({
      count: presets.length,
      keys,
      out,
      clear: true,
      render: (sel) => [
        ...box(
          presets.map((p, i) => ({
            text: `${i === sel ? '❯' : ' '} ${i + 1}. ${p.label.padEnd(8)} ${p.summary}`,
            paint: i === sel ? c.cyan : (t: string) => t,
          })),
          { title: '¿Qué quieres conectar?', width: termWidth(), border: c.cyan },
        ),
        c.dim('  ↑↓ elegir · Enter confirmar · Esc cancelar'),
      ],
    });
    if (choice === 'cancel') return false;
    preset = presets[choice];
    if (!preset) return false;
  }

  const inner = termWidth() - 6;
  const steps = preset.steps.flatMap((step) => wrapText(step, inner).map((line, i) => (i ? `   ${line}` : line)));
  out.write(`${box(steps, { title: `Conectar ${preset.label}`, width: termWidth(), border: c.cyan }).join('\n')}\n`);

  const values: Record<string, string> = {};
  for (const field of preset.fields) {
    if (field.secret && field.envVar) {
      if (env[field.envVar]) {
        ui.notice(`✔ ${field.label}: ya está en tu entorno (${field.envVar}), la uso.`);
        continue;
      }
      const secret = (await readSecret(`${field.label} (no se muestra): `, { keys, out }))?.trim();
      if (!secret) {
        ui.warn('Cancelado: no se guardó nada.');
        return false;
      }
      await saveCredential(field.envVar, secret, credFile);
      env[field.envVar] = secret;
      ui.notice(`✔ Guardado como ${field.envVar} en ${credFile} (${maskSecret(secret)})`);
    } else {
      const value = (await rl.question(`${field.label}: `)).trim();
      if (!value && !field.optional) {
        ui.warn('Ese dato es obligatorio. Cancelado: no se configuró nada.');
        return false;
      }
      if (value) values[field.key] = value;
    }
  }

  const server = preset.build(values);
  const cfg = McpServerSchema.parse(server);
  ui.thinking('Probando la conexión');
  const [status] = await mcp.add({ [preset.id]: cfg }, CONNECT_TIMEOUT_MS);
  ui.idle();

  let autoApprove: string[] = [];
  if (!status?.ok) {
    ui.error(`No se pudo conectar a ${preset.label}: ${status?.error ?? 'sin detalle'}`);
    ui.notice(connectionHint(status?.error ?? ''));
    const keep = await d.choose({ title: 'Conexión fallida', approve: 'Guardar la configuración igualmente', cancel: 'No guardar' });
    if (keep.kind !== 'approve') return false;
  } else {
    const { read, write } = splitTools(status.tools, preset.id);
    ui.notice(`✔ Conectado: ${status.tools.length} herramientas (${read.length} de lectura, ${write.length} de escritura)`);
    if (read.length) {
      const reply = await d.choose({
        title: 'Herramientas de lectura',
        detail: [...read.slice(0, 10), ...(read.length > 10 ? [`… y ${read.length - 10} más`] : [])],
        approve: 'Sí, que no pregunte al leer (las de escritura siguen preguntando)',
        cancel: 'No, que pregunte siempre',
      });
      if (reply.kind === 'approve') {
        autoApprove = read;
        cfg.autoApprove = read; // la conexión ya abierta usa este mismo objeto
      }
    }
  }

  const path = d.configFile ?? globalConfigFile();
  const current = await readFile(path, 'utf8').catch(() => undefined);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, mergeServer(current, preset.id, { ...server, ...(autoApprove.length ? { autoApprove } : {}) }));
  ui.notice(`✔ ${preset.label} configurado en ${path} (vale para todos tus proyectos)${status?.ok ? '. Prueba: /issues' : ''}`);
  return Boolean(status?.ok);
}

/** Instrucciones para conseguir la clave del proveedor de un modelo ("google/…"), para mensajes de error o ayuda. */
export function keyInstructions(modelId: string, config: Config): string {
  const { provider } = parseModelId(modelId);
  const help = PROVIDER_HELP[provider];
  const env = config.providers[provider]?.apiKeyEnv ?? DEFAULT_KEY_ENV[provider];
  if (!env) return help ? `${help.label}: ${help.note}` : `El proveedor "${provider}" no tiene una clave estándar; define apiKeyEnv en ${CONFIG_FILE}.`;
  return [
    `Falta la clave de ${help?.label ?? provider} (variable ${env}).`,
    help?.url ? `Créala en ${help.url}` : '',
    help?.note ?? '',
    'Pégala con /login o expórtala: export ' + `${env}=...`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Pide la clave del proveedor del modelo actual, la comprueba y la guarda fuera del repo. */
export async function loginProvider(d: ConnectDeps, modelId: string): Promise<boolean> {
  const { ui, keys, out } = d;
  const env = d.env ?? process.env;
  const { provider } = parseModelId(modelId);
  const help = PROVIDER_HELP[provider];
  const envVar = d.config.providers[provider]?.apiKeyEnv ?? DEFAULT_KEY_ENV[provider];
  if (!envVar) {
    ui.notice(keyInstructions(modelId, d.config));
    return false;
  }
  const lines = [help?.url ? `Créala en ${help.url}` : `Variable: ${envVar}`, ...(help?.note ? wrapText(help.note, termWidth() - 6) : [])];
  out.write(`${box(lines, { title: `Clave de ${help?.label ?? provider}`, width: termWidth(), border: c.cyan }).join('\n')}\n`);

  const key = (await readSecret(`${envVar} (no se muestra): `, { keys, out }))?.trim();
  if (!key) {
    ui.warn('Cancelado: no se guardó nada.');
    return false;
  }
  ui.thinking('Comprobando la clave');
  const check = await checkApiKey(provider, key, d.fetchImpl);
  ui.idle();
  if (check === 'invalid') {
    ui.error('El proveedor rechazó la clave.');
    const keep = await d.choose({ title: 'Clave rechazada', approve: 'Guardarla igualmente', cancel: 'No guardar' });
    if (keep.kind !== 'approve') return false;
  } else ui.notice(check === 'valid' ? '✔ Clave válida' : '(no pude comprobarla ahora; se guarda igualmente)');

  await saveCredential(envVar, key, d.credFile ?? credentialsFile());
  env[envVar] = key;
  ui.notice(`✔ Guardada como ${envVar} (${maskSecret(key)}). Ya puedes usar ${modelId}.`);
  return true;
}
