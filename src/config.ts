import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/** Roles de modelo: cada etapa del flujo puede usar un modelo distinto. */
export const ROLES = ['plan', 'implement', 'light'] as const;
export type Role = (typeof ROLES)[number];

const ProviderConfig = z.object({
  baseURL: z.string().optional(),
  apiKeyEnv: z.string().optional(),
});

const ConfigSchema = z.object({
  /** Modelo por defecto, formato "proveedor/modelo". */
  model: z.string().default('google/gemini-flash-latest'),
  /** Sobrescribe el modelo para un rol concreto. */
  roles: z.partialRecord(z.enum(ROLES), z.string()).default({}),
  /** Proveedores personalizados o con URL propia (p. ej. ollama, openai-compatible). */
  providers: z.record(z.string(), ProviderConfig).default({}),
  /** Máximo de pasos del bucle agéntico por turno. */
  maxSteps: z.number().int().positive().default(40),
  /** Comandos bash permitidos sin preguntar (prefijos). */
  allowedCommands: z
    .array(z.string())
    .default(['git status', 'git diff', 'git log', 'ls', 'cat', 'npm test', 'npm run test', 'npm run lint', 'npm run typecheck']),
});

export type Config = z.infer<typeof ConfigSchema>;

export const CONFIG_FILE = 'agente.config.json';

export async function loadConfig(cwd: string): Promise<Config> {
  let raw = '{}';
  try {
    raw = await readFile(join(cwd, CONFIG_FILE), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return ConfigSchema.parse(JSON.parse(raw));
}

/** Modelo efectivo para un rol: rol → modelo por defecto. */
export function modelFor(config: Config, role: Role): string {
  return config.roles[role] ?? config.model;
}
