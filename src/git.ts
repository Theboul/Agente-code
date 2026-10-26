import { spawn } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Ejecuta git SIN shell (los argumentos nunca se interpretan). */
export function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((res) => {
    const child = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d));
    child.stderr.on('data', (d: Buffer) => (stderr += d));
    child.on('error', (e) => res({ code: 127, stdout, stderr: e.message }));
    child.on('close', (code) => res({ code: code ?? 1, stdout, stderr }));
  });
}

export async function gitOk(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} falló: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

export async function repoRoot(cwd: string): Promise<string | undefined> {
  const r = await git(cwd, ['rev-parse', '--show-toplevel']);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

export async function hasCommits(cwd: string): Promise<boolean> {
  return (await git(cwd, ['rev-parse', '--verify', 'HEAD'])).code === 0;
}

export const currentBranch = (cwd: string) => gitOk(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);

export async function isClean(cwd: string): Promise<boolean> {
  return (await gitOk(cwd, ['status', '--porcelain'])) === '';
}

export async function branchExists(cwd: string, name: string): Promise<boolean> {
  return (await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`])).code === 0;
}

/** Carpeta privada de agente dentro de .git (no ensucia el árbol de trabajo). */
export async function agentDir(cwd: string): Promise<string> {
  const common = await gitOk(cwd, ['rev-parse', '--git-common-dir']);
  return join(resolve(cwd, common), 'agente');
}

export function defaultWorktreeDir(root: string): string {
  return join(dirname(root), `${basename(root)}-worktrees`);
}

export async function createBranch(cwd: string, name: string, base?: string): Promise<void> {
  await gitOk(cwd, ['checkout', '-b', name, ...(base ? [base] : [])]);
}

export async function addWorktree(root: string, path: string, branch: string, base: string): Promise<void> {
  await gitOk(root, ['worktree', 'add', '-b', branch, path, base]);
}

/** Diff completo contra HEAD, incluyendo archivos nuevos sin seguimiento. */
export async function fullDiff(cwd: string): Promise<{ stat: string; patch: string }> {
  await gitOk(cwd, ['add', '-N', '.']); // marca archivos nuevos para que aparezcan en el diff
  return { stat: await gitOk(cwd, ['diff', 'HEAD', '--stat']), patch: await gitOk(cwd, ['diff', 'HEAD']) };
}

/** "Arreglar el Login!" → "arreglar-el-login" (sin acentos, máx. 40 caracteres). */
export function slugify(text: string, max = 40): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}
