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

const McpServerConfig = z
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
    enabled: z.boolean().default(true),
  })
  .refine((s) => Boolean(s.command) !== Boolean(s.url), { message: 'Define "command" (stdio) o "url" (remoto), no ambos.' });

export type McpServerConfig = z.infer<typeof McpServerConfig>;

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
  /** Qué issues listar con `agente issues` (lenguaje natural, se lo pasa al modelo). */
  issueQuery: z.string().default('abiertas, sin asignar o asignadas a mí, las más recientes primero'),
});

export type WorkflowConfig = z.infer<typeof WorkflowConfig>;

const ConfigSchema = z.object({
  /** Modelo por defecto, formato "proveedor/modelo". */
  model: z.string().default('google/gemini-3.5-flash-lite'),
  /** Sobrescribe el modelo para un rol concreto. */
  roles: z.partialRecord(z.enum(ROLES), z.string()).default({}),
  /** Proveedores personalizados o con URL propia (p. ej. ollama, openai-compatible). */
  providers: z.record(z.string(), ProviderConfig).default({}),
  /** Servidores MCP (Jira, Trello, GitHub…). Los valores admiten ${VARIABLE} del entorno. */
  mcpServers: z.record(z.string(), McpServerConfig).default({}),
  workflow: WorkflowConfig.prefault({}),
  /** Ventana de contexto del modelo en tokens; al pasar de `compactAt` el historial se resume. */
  contextWindow: z.number().int().positive().default(128_000),
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
