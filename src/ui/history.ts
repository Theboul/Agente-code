import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const MAX = 500;

export const defaultHistoryFile = (): string => join(process.env.AGENTE_HOME ?? join(homedir(), '.agente'), 'history');

/** Historial de entradas, de la más reciente a la más antigua (el orden que espera readline). */
export async function loadHistory(file: string): Promise<string[]> {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean).slice(-MAX).reverse();
  } catch {
    return [];
  }
}

/** Añade una línea al archivo (solo el dueño puede leerlo: puede contener datos sensibles). Los fallos se ignoran. */
export async function appendHistory(file: string, line: string): Promise<void> {
  const clean = line.replace(/[\r\n]+/g, ' ').trim();
  if (!clean) return;
  try {
    const prev = (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    if (prev.at(-1) === clean) return;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${[...prev, clean].slice(-MAX).join('\n')}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
  } catch {
    /* el historial es una comodidad, nunca debe romper la sesión */
  }
}
