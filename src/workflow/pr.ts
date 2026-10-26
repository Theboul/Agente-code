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
}

export type PrCreator = (req: PrRequest) => Promise<PrOutcome>;

export type PrMethod = 'auto' | 'gh' | 'mcp' | 'manual';

export const hasMcpPrTool = (toolNames: string[]) => toolNames.some((n) => /create[-_]?(pull[-_]?request|merge[-_]?request|pr)\b/i.test(n));

export async function ghReady(cwd: string): Promise<boolean> {
  return (await exec('gh', ['auth', 'status'], cwd)).code === 0;
}

/** Elige el método: gh autenticado → herramienta MCP de PR → enlace manual. */
export function makePrCreator(o: {
  method: PrMethod;
  runStage: StageRunner;
  mcpToolNames: string[];
  ghReady?: (cwd: string) => Promise<boolean>;
}): PrCreator {
  return async (req) => {
    let method = o.method;
    if (method === 'auto') {
      if (await (o.ghReady ?? ghReady)(req.workdir)) method = 'gh';
      else if (hasMcpPrTool(o.mcpToolNames)) method = 'mcp';
      else method = 'manual';
    }

    const dir = join(await agentDir(req.root), 'pr');
    await mkdir(dir, { recursive: true });
    const bodyFile = join(dir, `${req.branch.replace(/\//g, '-')}.md`);
    await writeFile(bodyFile, req.body);

    if (method === 'gh') {
      const args = ['pr', 'create', '--base', req.base, '--head', req.branch, '--title', req.title, '--body-file', bodyFile];
      if (req.draft) args.push('--draft');
      const r = await exec('gh', args, req.workdir);
      if (r.code !== 0) throw new Error(`gh pr create falló: ${(r.stderr || r.stdout).trim()}`);
      const url = r.stdout.trim().split('\n').pop()!.trim();
      return { method: 'gh', url, bodyFile };
    }

    if (method === 'mcp') {
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

    return { method: 'manual', manualUrl: compareUrl(req.remoteUrl, req.base, req.branch), bodyFile };
  };
}
