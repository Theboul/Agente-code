import { spawn } from 'node:child_process';

const MAX_OUTPUT = 30_000;

export interface CommandResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

/** Ejecuta un comando con bash -c. Nunca rechaza: los errores se devuelven como resultado. */
export function execCommand(cwd: string, command: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], { cwd, signal });
    let out = '';
    const onData = (d: Buffer) => {
      if (out.length < MAX_OUTPUT) out += d.toString();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, output: `Error al ejecutar: ${e.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const body = out.length >= MAX_OUTPUT ? out.slice(0, MAX_OUTPUT) + '\n…[salida truncada]' : out;
      resolve({ code, output: body, timedOut });
    });
  });
}

/** Igual que execCommand pero con el formato de texto que ve el modelo. */
export async function runCommand(cwd: string, command: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const r = await execCommand(cwd, command, timeoutMs, signal);
  const status = r.timedOut ? 'señal SIGKILL' : r.code;
  return `${r.output}\n[exit ${status}]`;
}
