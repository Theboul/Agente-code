import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { ToolSet } from 'ai';
import type { McpServerConfig } from '../config.js';
import { agenteHome } from '../credentials.js';
import { authorizeDetailed, denialMessage, type Permissions } from '../permissions.js';

export interface McpServerStatus {
  name: string;
  ok: boolean;
  tools: string[];
  error?: string;
}

export interface McpConnections {
  tools: ToolSet;
  status: McpServerStatus[];
  /** Conecta más servidores en caliente (p. ej. tras /connect). Devuelve el estado de cada uno. */
  add(servers: Record<string, McpServerConfig>, timeoutMs?: number): Promise<McpServerStatus[]>;
  close(): Promise<void>;
}

/** Sustituye ${VAR} por process.env.VAR; falla con un mensaje claro si falta. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const v = env[name];
    if (v === undefined) throw new Error(`Falta la variable de entorno ${name}`);
    return v;
  });
}

const expandRecord = (r: Record<string, string>, env?: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, expandEnv(v, env)]));

/** Nombre expuesto al modelo: mcp__servidor__herramienta, solo [a-zA-Z0-9_-] y máx. 64 caracteres. */
export function toolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}

export function needsApproval(cfg: McpServerConfig, originalTool: string): boolean {
  if (cfg.autoApprove === true) return false;
  return !(Array.isArray(cfg.autoApprove) && cfg.autoApprove.includes(originalTool));
}

/**
 * Los servidores locales escriben sus logs por stderr. Heredarlo ensucia la terminal del usuario (logs e incluso stack traces),
 * así que se redirige a ~/.agente/logs/mcp-<servidor>.log. Se pasa un descriptor de archivo porque `spawn` no admite un stream propio.
 * Si no se puede abrir el log, se descarta.
 */
function openServerLog(name: string): { fd?: number; file?: string } {
  try {
    const dir = join(agenteHome(), 'logs');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `mcp-${name.replace(/[^\w.-]/g, '_')}.log`);
    return { fd: openSync(file, 'a'), file };
  } catch {
    return {};
  }
}

async function connectOne(name: string, cfg: McpServerConfig, perms: Permissions, timeoutMs: number) {
  const log = cfg.command ? openServerLog(name) : {};
  const transport = cfg.command
    ? new StdioMCPTransport({
        command: expandEnv(cfg.command),
        args: cfg.args.map((a) => expandEnv(a)),
        env: { ...cleanEnv(), ...expandRecord(cfg.env) },
        stderr: log.fd ?? 'ignore',
      })
    : { type: cfg.transport, url: expandEnv(cfg.url!), headers: expandRecord(cfg.headers) };
  const closeLog = () => {
    if (log.fd !== undefined) {
      try {
        closeSync(log.fd);
      } catch {}
    }
  };

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`Tiempo de espera agotado (${timeoutMs / 1000}s)`)), timeoutMs);
  });
  let client: MCPClient;
  try {
    client = await Promise.race([createMCPClient({ transport, name: 'agente' }), timeout]).finally(() => clearTimeout(timer));
  } catch (e) {
    closeLog();
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(log.file ? `${msg} (log del servidor: ${log.file})` : msg);
  }

  try {
    const raw = await client.tools();
    const tools: ToolSet = {};
    for (const [original, t] of Object.entries(raw)) {
      const exposed = toolName(name, original);
      const exec = t.execute;
      if (!exec) continue;
      tools[exposed] = {
        ...t,
        execute: async (input: never, options: never) => {
          if (needsApproval(cfg, original)) {
            const args = JSON.stringify(input, null, 2).split('\n');
            const reply = await authorizeDetailed(perms, 'ask', {
              kind: 'mcp',
              title: 'Herramienta MCP',
              target: `${name}/${original}`,
              preview: args.slice(0, 12),
              question: `¿Ejecutar herramienta MCP ${name}/${original}?\n  ${JSON.stringify(input).slice(0, 400)}`,
              session: { key: `mcp:${name}/${original}`, label: `la herramienta ${name}/${original}` },
            });
            if (!reply.allow) return denialMessage(reply);
          }
          return exec(input, options);
        },
      } as ToolSet[string];
    }
    return { client, tools, closeLog };
  } catch (e) {
    await client.close().catch(() => {});
    closeLog();
    throw e;
  }
}

// Lo mínimo para que un servidor local arranque y llegue a internet. Las claves de modelos y demás secretos NO pasan.
const PASS_THROUGH = [
  // sistema
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'NODE_PATH',
  // Windows (npx y Node los necesitan para encontrar su caché y sus programas)
  'SystemRoot',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PATHEXT',
  'COMSPEC',
  'ProgramFiles',
  'ProgramData',
  'HOMEDRIVE',
  'HOMEPATH',
  // red: proxys y certificados propios (redes corporativas); sin ellos el servidor no saldría a internet
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_USE_ENV_PROXY',
];

/** Entorno con el que arrancan los servidores MCP locales: solo lo de PASS_THROUGH. */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(PASS_THROUGH.flatMap((k) => (env[k] !== undefined ? [[k, env[k]!]] : [])));
}

/** Conecta todos los servidores en paralelo; un servidor caído no impide usar el resto. */
export async function connectMcpServers(servers: Record<string, McpServerConfig>, perms: Permissions, timeoutMs = 20_000): Promise<McpConnections> {
  const clients: MCPClient[] = [];
  const closers: (() => void)[] = [];
  const tools: ToolSet = {};
  const status: McpServerStatus[] = [];

  const add = async (more: Record<string, McpServerConfig>, addTimeoutMs = timeoutMs): Promise<McpServerStatus[]> => {
    const added: McpServerStatus[] = [];
    await Promise.all(
      Object.entries(more)
        .filter(([, c]) => c.enabled)
        .map(async ([name, cfg]) => {
          let st: McpServerStatus;
          try {
            const r = await connectOne(name, cfg, perms, addTimeoutMs);
            clients.push(r.client);
            closers.push(r.closeLog);
            Object.assign(tools, r.tools);
            st = { name, ok: true, tools: Object.keys(r.tools) };
          } catch (e) {
            st = { name, ok: false, tools: [], error: e instanceof Error ? e.message : String(e) };
          }
          const old = status.findIndex((x) => x.name === name);
          if (old >= 0) status.splice(old, 1);
          status.push(st);
          added.push(st);
        }),
    );
    status.sort((a, b) => a.name.localeCompare(b.name));
    return added;
  };

  await add(servers);
  return {
    tools,
    status,
    add,
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
      for (const closeLog of closers) closeLog();
    },
  };
}
