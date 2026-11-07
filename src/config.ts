import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { agenteHome } from './credentials.js';

/** Roles de modelo: cada etapa del flujo puede usar un modelo distinto. */
export const ROLES = ['plan', 'implement', 'light'] as const;
export type Role = (typeof ROLES)[number];

const ProviderConfig = z.object({
  baseURL: z.string().optional(),
  apiKeyEnv: z.string().optional(),
});

export const McpServerSchema = z
  .object({
    /** Servidor local (stdio). */
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    /** Servidor remoto (HTTP en streaming o SSE). */
    url: z.string().optional(),
    transport: z.enum(['http', 'sse']).default('http'),
    headers: z.record(z.string(), z.string()).default({}),
    /** Herramientas que se ejecutan sin preguntar: lista de nombres originales, o true para todas. */
    autoApprove: z.union([z.boolean(), z.array(z.string())]).default([]),
    /** Solo estas herramientas (nombres originales) se exponen al modelo. Menos herramientas = menos tokens por turno. Sin definir: todas. */
    includeTools: z.array(z.string()).optional(),
    /** Herramientas que no se exponen al modelo (se aplica tras includeTools). */
    excludeTools: z.array(z.string()).optional(),
    enabled: z.boolean().default(true),
  })
  .refine((s) => Boolean(s.command) !== Boolean(s.url), { message: 'Define "command" (stdio) o "url" (remoto), no ambos.' });

export type McpServerConfig = z.infer<typeof McpServerSchema>;

const WorkflowConfig = z.object({
  /** Prefijo de las ramas creadas, p. ej. "feat/" → feat/proj-123-arreglar-login. */
  branchPrefix: z.string().default('feat/'),
  /** "branch": rama en el propio repo (exige árbol limpio). "worktree": copia aislada en otra carpeta. */
  isolation: z.enum(['branch', 'worktree']).default('branch'),
  /** Carpeta de los worktrees. Por defecto "../<repo>-worktrees". */
  worktreeDir: z.string().optional(),
  /** Comandos tras crear un worktree (instalar dependencias). Si falta, se detecta (p. ej. npm ci). */
  setup: z.array(z.string()).optional(),
  /** Comandos de verificación, en orden. Si falta, se detectan (lint, typecheck, test…). [] = sin verificación. */
  verify: z.array(z.string()).optional(),
  /** Intentos de corrección automática cuando falla la verificación. */
  maxFixAttempts: z.number().int().min(0).default(3),
  /** Remoto al que se hace push. */
  remote: z.string().default('origin'),
  /** Ramas en las que nunca se hace commit/push desde el flujo (además de la rama base). */
  protectedBranches: z.array(z.string()).default(['main', 'master']),
  /** Reintentos del push ante fallos de red (espera 2s, 4s, 8s, 16s…). */
  pushRetries: z.number().int().min(0).default(4),
  pr: z
    .object({
      /** auto: gh si está autenticado → herramienta MCP de PR → enlace manual. */
      method: z.enum(['auto', 'gh', 'mcp', 'manual']).default('auto'),
      draft: z.boolean().default(false),
    })
    .prefault({}),
  /** Tras abrir el PR, comentar en la issue del tracker (vía MCP). */
  sync: z.boolean().default(true),
  /** Estado al que mover la issue tras el PR, p. ej. "In Review". Vacío = solo comentar. */
  syncStatus: z.string().optional(),
  /** Servidor MCP del tracker de issues (p. ej. "jira"). Con varios servidores conectados (Jira + GitHub), evita que el modelo consulte el equivocado. Sin definir: todos. */
  tracker: z.string().optional(),
  /** Qué issues listar con `agente issues` (lenguaje natural, se lo pasa al modelo). */
  issueQuery: z.string().default('abiertas, sin asignar o asignadas a mí, las más recientes primero'),
});

export type WorkflowConfig = z.infer<typeof WorkflowConfig>;

const SubagentsConfig = z.object({
  /** Permite al modelo delegar investigaciones de solo lectura en un subagente (herramienta `delegate`). */
  enabled: z.boolean().default(true),
  /** Pasos máximos de cada subagente; al llegar devuelve un resultado parcial. */
  maxSteps: z.number().int().positive().default(12),
  /** Subagentes a la vez. 1 = en serie: con los planes gratuitos (≈15 peticiones por minuto) el paralelo agota la cuota. */
  maxParallel: z.number().int().positive().default(1),
  /** Tamaño máximo del resultado que vuelve al modelo principal. */
  maxResultChars: z.number().int().positive().default(4000),
  /** Modelo del subagente. Si falta, el del rol `light`. */
  model: z.string().optional(),
});

export type SubagentsConfig = z.infer<typeof SubagentsConfig>;

const ConfigSchema = z.object({
  /** Modelo por defecto, formato "proveedor/modelo". */
  model: z.string().default('google/gemini-3.5-flash-lite'),
  /** Sobrescribe el modelo para un rol concreto. */
  roles: z.partialRecord(z.enum(ROLES), z.string()).default({}),
  /** Proveedores personalizados o con URL propia (p. ej. ollama, openai-compatible). */
  providers: z.record(z.string(), ProviderConfig).default({}),
  /** Servidores MCP (Jira, Trello, GitHub…). Los valores admiten ${VARIABLE} del entorno. */
  mcpServers: z.record(z.string(), McpServerSchema).default({}),
  workflow: WorkflowConfig.prefault({}),
  subagents: SubagentsConfig.prefault({}),
  /** Ventana de contexto en tokens. Si falta se usa la del modelo (ver models.ts); al pasar de `compactAt` el historial se resume. */
  contextWindow: z.number().int().positive().optional(),
  compactAt: z.number().min(0.3).max(0.95).default(0.75),
  /** Segundos sin respuesta del modelo antes de abortar (no cuenta el tiempo de las herramientas). */
  requestTimeoutSeconds: z.number().int().positive().default(90),
  /** Máximo de pasos del bucle agéntico por turno. */
  maxSteps: z.number().int().positive().default(40),
  /** Comandos bash permitidos sin preguntar (prefijos). */
  allowedCommands: z
    .array(z.string())
    .default(['git status', 'git diff', 'git log', 'ls', 'cat', 'npm test', 'npm run test', 'npm run lint', 'npm run typecheck']),
});

export type Config = z.infer<typeof ConfigSchema>;

export const CONFIG_FILE = 'agente.config.json';

/** Configuración global del usuario (vale para todos sus proyectos). La escribe /connect. */
export const globalConfigFile = (): string => join(agenteHome(), 'config.json');

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Mezcla en profundidad: los objetos se combinan clave a clave y lo demás (listas, valores) lo reemplaza `over`. */
export function mergeConfig(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeConfig(out[k] as Record<string, unknown>, v) : v;
  return out;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isPlainObject(parsed)) throw new Error(`${file} no es un objeto JSON.`);
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
}

/** Configuración efectiva: global del usuario (~/.agente/config.json) y encima la del proyecto (agente.config.json). */
export async function loadConfig(cwd: string, globalFile: string = globalConfigFile()): Promise<Config> {
  const merged = mergeConfig(await readJson(globalFile), await readJson(join(cwd, CONFIG_FILE)));
  return ConfigSchema.parse(merged);
}

/** Modelo efectivo para un rol: rol → modelo por defecto. */
export function modelFor(config: Config, role: Role): string {
  return config.roles[role] ?? config.model;
}
