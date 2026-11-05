import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentDir, compareUrl, exec } from '../git.js';
import { extractJson } from './issue.js';
import type { StageRunner } from './run.js';

export interface PrRequest {
  root: string;
  workdir: string;
  remoteUrl: string;
  base: string;
  branch: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface PrOutcome {
  method: 'gh' | 'mcp' | 'manual';
  /** URL del PR creado. */
  url?: string;
  /** Si no se pudo crear automáticamente: enlace para abrirlo a mano. */
  manualUrl?: string;
  bodyFile?: string;
  /** Aviso para el usuario: por qué se cayó al método siguiente. */
  note?: string;
}

export type PrCreator = (req: PrRequest) => Promise<PrOutcome>;

export type PrMethod = 'auto' | 'gh' | 'mcp' | 'manual';

export const hasMcpPrTool = (toolNames: string[]) => toolNames.some((n) => /create[-_]?(pull[-_]?request|merge[-_]?request|pr)\b/i.test(n));

export async function ghReady(cwd: string): Promise<boolean> {
  return (await exec('gh', ['auth', 'status'], cwd)).code === 0;
}

type PrOptions = { method: PrMethod; runStage: StageRunner; mcpToolNames: string[]; ghReady?: (cwd: string) => Promise<boolean> };

async function createWithGh(req: PrRequest, bodyFile: string): Promise<PrOutcome> {
  const args = ['pr', 'create', '--base', req.base, '--head', req.branch, '--title', req.title, '--body-file', bodyFile];
  if (req.draft) args.push('--draft');
  const r = await exec('gh', args, req.workdir);
  if (r.code !== 0) throw new Error(`gh pr create falló: ${(r.stderr || r.stdout).trim()}`);
  return { method: 'gh', url: r.stdout.trim().split('\n').pop()!.trim(), bodyFile };
}

async function createWithMcp(o: PrOptions, req: PrRequest, bodyFile: string): Promise<PrOutcome> {
  const r = await o.runStage({
    role: 'light',
    system: 'Gestionas repositorios con herramientas MCP. Responde siempre en el formato pedido.',
    tools: 'mcp',
    workdir: req.workdir,
    messages: [
      {
        role: 'user',
        content: `Crea un pull request con la herramienta MCP correspondiente.
Repositorio (remoto): ${req.remoteUrl}
Rama origen (head): ${req.branch}
Rama destino (base): ${req.base}
Borrador: ${req.draft ? 'sí' : 'no'}
Título: ${req.title}
Descripción:
${req.body}

Responde SOLO con un bloque \`\`\`json: {"url": "<url del PR creado>"}`,
      },
    ],
  });
  const url = (extractJson(r.text) as { url?: string }).url;
  if (!url) throw new Error('La herramienta MCP no devolvió la URL del PR.');
  return { method: 'mcp', url, bodyFile };
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 200);

/**
 * Crea el PR. En modo `auto` prueba en orden gh autenticado → herramienta MCP de PR → enlace manual, y si un método
 * falla pasa al siguiente (la rama ya está subida: no tiene sentido abortar). Con un método explícito el fallo se propaga.
 */
export function makePrCreator(o: PrOptions): PrCreator {
  return async (req) => {
    const dir = join(await agentDir(req.root), 'pr');
    await mkdir(dir, { recursive: true });
    const bodyFile = join(dir, `${req.branch.replace(/\//g, '-')}.md`);
    await writeFile(bodyFile, req.body);

    const manual = (note?: string): PrOutcome => ({ method: 'manual', manualUrl: compareUrl(req.remoteUrl, req.base, req.branch), bodyFile, note });
    if (o.method === 'manual') return manual();

    const order: ('gh' | 'mcp')[] =
      o.method === 'auto'
        ? [...((await (o.ghReady ?? ghReady)(req.workdir)) ? (['gh'] as const) : []), ...(hasMcpPrTool(o.mcpToolNames) ? (['mcp'] as const) : [])]
        : [o.method];

    const failures: string[] = [];
    for (const method of order) {
      try {
        const outcome = method === 'gh' ? await createWithGh(req, bodyFile) : await createWithMcp(o, req, bodyFile);
        return failures.length ? { ...outcome, note: `Antes falló (${failures.join('; ')}).` } : outcome;
      } catch (e) {
        if (o.method !== 'auto') throw e;
        failures.push(`${method}: ${reason(e)}`);
      }
    }
    return manual(failures.length ? `Falló la creación automática (${failures.join('; ')}).` : undefined);
  };
}
