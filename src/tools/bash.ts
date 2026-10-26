import { spawn } from 'node:child_process';
import { tool } from 'ai';
import { z } from 'zod';
import { authorize, classifyCommand, type Permissions } from '../permissions.js';

const MAX_OUTPUT = 30_000;

export function runCommand(cwd: string, command: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], { cwd, signal });
    let out = '';
    const onData = (d: Buffer) => {
      if (out.length < MAX_OUTPUT) out += d.toString();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve(`Error al ejecutar: ${e.message}`);
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      const body = out.length >= MAX_OUTPUT ? out.slice(0, MAX_OUTPUT) + '\n…[salida truncada]' : out;
      resolve(`${body}\n[exit ${sig ? `señal ${sig}` : code}]`);
    });
  });
}

export function bashTool(cwd: string, perms: Permissions) {
  return tool({
    description: 'Ejecuta un comando de shell en la raíz del proyecto (tests, git, build...). Devuelve stdout+stderr y el código de salida.',
    inputSchema: z.object({
      command: z.string(),
      timeout_seconds: z.number().int().min(1).max(600).optional(),
    }),
    execute: async ({ command, timeout_seconds = 120 }, { abortSignal }) => {
      const decision = classifyCommand(command, perms.allowedCommands);
      if (decision === 'deny') return 'DENEGADO: comando bloqueado por la política de seguridad.';
      if (!(await authorize(perms, decision, `¿Ejecutar?  $ ${command}`))) return 'DENEGADO por el usuario.';
      return runCommand(cwd, command, timeout_seconds * 1000, abortSignal);
    },
  });
}
