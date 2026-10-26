import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentDir } from '../git.js';
import type { Issue } from './issue.js';

export interface RunRecord {
  status: 'ready' | 'cancelled' | 'failed';
  branch: string;
  workdir: string;
  base: string;
  verified?: boolean;
  issue: Issue;
  plan: string;
  shipped?: { commit?: string; pushed?: boolean; prUrl?: string; at: string };
}

const runsDir = async (root: string) => join(await agentDir(root), 'runs');

export async function saveRun(root: string, rec: RunRecord): Promise<string> {
  const dir = await runsDir(root);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${rec.branch.replace(/\//g, '-')}.json`);
  await writeFile(file, JSON.stringify(rec, null, 2));
  return file;
}

export async function updateRun(file: string, patch: Partial<RunRecord>): Promise<void> {
  const rec = JSON.parse(await readFile(file, 'utf8')) as RunRecord;
  await writeFile(file, JSON.stringify({ ...rec, ...patch }, null, 2));
}

/** Última ejecución del flujo para una rama (la más reciente que no fue cancelada). */
export async function findRun(root: string, branch: string): Promise<{ file: string; rec: RunRecord } | undefined> {
  const dir = await runsDir(root);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort().reverse();
  } catch {
    return undefined;
  }
  for (const n of names) {
    const file = join(dir, n);
    const rec = JSON.parse(await readFile(file, 'utf8')) as RunRecord;
    if (rec.branch === branch && rec.status !== 'cancelled') return { file, rec };
  }
  return undefined;
}
