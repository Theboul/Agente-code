import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execCommand } from '../tools/bash.js';

function runner(cwd: string): string {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm run';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn run';
  if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock'))) return 'bun run';
  return 'npm run';
}

function scripts(cwd: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).scripts ?? {};
  } catch {
    return {};
  }
}

/** Detecta lint → typecheck → test del proyecto. Se puede sobrescribir con workflow.verify. */
export function detectVerifyCommands(cwd: string): string[] {
  const s = scripts(cwd);
  const run = runner(cwd);
  const out = ['lint', 'typecheck', 'test']
    .filter((n) => s[n] && !/no test specified/.test(s[n]!))
    .map((n) => `${run} ${n}`);
  if (out.length) return out;
  if (existsSync(join(cwd, 'Cargo.toml'))) return ['cargo test'];
  if (existsSync(join(cwd, 'go.mod'))) return ['go test ./...'];
  return [];
}

/** Dependencias a instalar al crear un worktree (no viene con node_modules). */
export function detectSetupCommands(cwd: string): string[] {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return ['pnpm install --frozen-lockfile'];
  if (existsSync(join(cwd, 'yarn.lock'))) return ['yarn install --frozen-lockfile'];
  if (existsSync(join(cwd, 'package-lock.json'))) return ['npm ci'];
  if (existsSync(join(cwd, 'package.json'))) return ['npm install'];
  return [];
}

export interface VerifyFailure {
  command: string;
  output: string;
}

export interface VerifyReport {
  ok: boolean;
  /** Primer comando que falló; los siguientes no se ejecutan. */
  failure?: VerifyFailure;
  passed: string[];
}

const TAIL = 6000;

export async function runVerify(cwd: string, commands: string[], timeoutMs = 600_000): Promise<VerifyReport> {
  const passed: string[] = [];
  for (const command of commands) {
    const r = await execCommand(cwd, command, timeoutMs);
    if (r.code !== 0) {
      const out = r.output.length > TAIL ? '…' + r.output.slice(-TAIL) : r.output;
      const why = r.timedOut ? `Tiempo agotado (${timeoutMs / 1000}s)` : `código de salida ${r.code}`;
      return { ok: false, passed, failure: { command, output: `${why}\n${out}` } };
    }
    passed.push(command);
  }
  return { ok: true, passed };
}
