import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { ToolSet } from 'ai';
import type { McpServerConfig } from '../config.js';
import { authorize, type Permissions } from '../permissions.js';

export interface McpServerStatus {
  name: string;
  ok: boolean;
  tools: string[];
  error?: string;
}

export interface McpConnections {
  tools: ToolSet;
  status: McpServerStatus[];
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

const expandRecord = (r: Record<string, string>, env?: NodeJS.ProcessEnv) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, expandEnv(v, env)]));

/** Nombre expuesto al modelo: mcp__servidor__herramienta, solo [a-zA-Z0-9_-] y máx. 64 caracteres. */
export function toolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}

export function needsApproval(cfg: McpServerConfig, originalTool: string): boolean {
  if (cfg.autoApprove === true) return false;
  return !(Array.isArray(cfg.autoApprove) && cfg.autoApprove.includes(originalTool));
}

async function connectOne(name: string, cfg: McpServerConfig, perms: Permissions, timeoutMs: number) {
  const transport = cfg.command
    ? new StdioMCPTransport({ command: expandEnv(cfg.command), args: cfg.args.map((a) => expandEnv(a)), env: { ...cleanEnv(), ...expandRecord(cfg.env) } })
    : { type: cfg.transport, url: expandEnv(cfg.url!), headers: expandRecord(cfg.headers) };

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`Tiempo de espera agotado (${timeoutMs / 1000}s)`)), timeoutMs);
  });
  const client: MCPClient = await Promise.race([createMCPClient({ transport, name: 'agente' }), timeout]).finally(() => clearTimeout(timer));

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
            const q = `¿Ejecutar herramienta MCP ${name}/${original}?\n  ${JSON.stringify(input).slice(0, 400)}`;
            if (!(await authorize(perms, 'ask', q))) return 'DENEGADO por el usuario.';
          }
          return exec(input, options);
        },
      } as ToolSet[string];
    }
    return { client, tools };
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
}

/** Solo variables seguras del entorno para procesos stdio (sin filtrar claves de modelos). */
function cleanEnv(): Record<string, string> {
  const keep = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'NODE_PATH', 'SystemRoot'];
  return Object.fromEntries(keep.flatMap((k) => (process.env[k] !== undefined ? [[k, process.env[k]!]] : [])));
}

/** Conecta todos los servidores en paralelo; un servidor caído no impide usar el resto. */
export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
  perms: Permissions,
  timeoutMs = 20_000,
): Promise<McpConnections> {
  const entries = Object.entries(servers).filter(([, c]) => c.enabled);
  const clients: MCPClient[] = [];
  const tools: ToolSet = {};
  const status: McpServerStatus[] = [];

  await Promise.all(
    entries.map(async ([name, cfg]) => {
      try {
        const r = await connectOne(name, cfg, perms, timeoutMs);
        clients.push(r.client);
        Object.assign(tools, r.tools);
        status.push({ name, ok: true, tools: Object.keys(r.tools) });
      } catch (e) {
        status.push({ name, ok: false, tools: [], error: e instanceof Error ? e.message : String(e) });
      }
    }),
  );

  status.sort((a, b) => a.name.localeCompare(b.name));
  return { tools, status, close: async () => void (await Promise.allSettled(clients.map((c) => c.close()))) };
}
