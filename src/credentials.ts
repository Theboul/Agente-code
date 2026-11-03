import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Carpeta de configuración del usuario (fuera de cualquier repositorio). Se cambia con AGENTE_HOME. */
export const agenteHome = (): string => process.env.AGENTE_HOME ?? join(homedir(), '.agente');

export const credentialsFile = (): string => join(agenteHome(), 'credentials');

/** Lee un archivo de líneas CLAVE=valor (admite comentarios con #). */
export function parseCredentials(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

export async function loadCredentials(file = credentialsFile()): Promise<Record<string, string>> {
  try {
    return parseCredentials(await readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Carga las credenciales guardadas en el entorno del proceso. Lo que ya está exportado en el entorno
 * manda: el archivo solo rellena lo que falta. Devuelve los nombres que aplicó.
 */
export async function applyCredentials(env: NodeJS.ProcessEnv = process.env, file = credentialsFile()): Promise<string[]> {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(await loadCredentials(file))) {
    if (!env[key] && value) {
      env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Guarda o actualiza una credencial. El archivo queda en una carpeta y con permisos solo para el dueño. */
export async function saveCredential(name: string, value: string, file = credentialsFile()): Promise<void> {
  if (!VALID_NAME.test(name)) throw new Error(`Nombre de variable inválido: ${name}`);
  if (/[\r\n]/.test(value) || !value.trim()) throw new Error('El valor no puede estar vacío ni tener saltos de línea.');
  const current = await loadCredentials(file);
  current[name] = value.trim();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const body = `# Credenciales de agente. No las subas a git ni las compartas.\n${Object.entries(current)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`;
  await writeFile(file, body, { mode: 0o600 });
  await chmod(file, 0o600);
}

/** "••••abcd": para confirmar qué se guardó sin mostrar el secreto. */
export const maskSecret = (s: string): string => (s.length <= 8 ? '••••' : `••••${s.slice(-4)}`);
