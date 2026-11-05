export interface PresetField {
  key: string;
  label: string;
  /** Los secretos se piden sin eco y se guardan en las credenciales del usuario, no en la configuración. */
  secret?: boolean;
  /** Variable de entorno donde vive el secreto (la configuración solo guarda ${VARIABLE}). */
  envVar?: string;
  optional?: boolean;
}

/** Servidor tal como se escribe en agente.config.json (antes de aplicar valores por defecto). */
export type ServerJson = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

export interface Preset {
  id: string;
  label: string;
  summary: string;
  /** Cómo conseguir las credenciales, paso a paso. */
  steps: string[];
  fields: PresetField[];
  build(values: Record<string, string>): ServerJson;
}

/** Referencia a una variable de entorno en la configuración: la expande el cliente MCP al conectar. */
const ref = (name: string): string => `$\{${name}}`;

export const PRESETS: Preset[] = [
  {
    id: 'jira',
    label: 'Jira',
    summary: 'Issues de Jira Cloud (token de API)',
    steps: [
      '1. Entra a https://id.atlassian.com/manage-profile/security/api-tokens',
      '2. "Crear token de API", ponle un nombre y cópialo.',
      '3. Tu sitio es la parte antes de .atlassian.net (tu-empresa.atlassian.net → tu-empresa).',
    ],
    fields: [
      { key: 'site', label: 'Nombre del sitio (tu-empresa)' },
      { key: 'email', label: 'Email de tu cuenta de Atlassian' },
      { key: 'token', label: 'Token de API', secret: true, envVar: 'JIRA_API_TOKEN' },
    ],
    build: (v) => ({
      command: 'npx',
      args: ['-y', '@aashari/mcp-server-atlassian-jira'],
      env: { ATLASSIAN_SITE_NAME: v.site ?? '', ATLASSIAN_USER_EMAIL: v.email ?? '', ATLASSIAN_API_TOKEN: ref('JIRA_API_TOKEN') },
    }),
  },
  {
    id: 'trello',
    label: 'Trello',
    summary: 'Tableros y tarjetas de Trello',
    steps: [
      '1. Entra a https://trello.com/power-ups/admin y crea un Power-Up (o abre el que tengas).',
      '2. En "Claves de API" genera la clave y copia la API Key.',
      '3. En esa misma página usa el enlace "Token" para autorizar tu cuenta y copia el token.',
    ],
    fields: [
      { key: 'apiKey', label: 'API Key', secret: true, envVar: 'TRELLO_API_KEY' },
      { key: 'token', label: 'Token', secret: true, envVar: 'TRELLO_TOKEN' },
      { key: 'boardId', label: 'ID del tablero por defecto (opcional, Enter para omitir)', optional: true },
    ],
    build: (v) => ({
      command: 'npx',
      args: ['-y', '@delorenj/mcp-server-trello'],
      env: { TRELLO_API_KEY: ref('TRELLO_API_KEY'), TRELLO_TOKEN: ref('TRELLO_TOKEN'), ...(v.boardId ? { TRELLO_BOARD_ID: v.boardId } : {}) },
    }),
  },
  {
    id: 'github',
    label: 'GitHub',
    summary: 'Issues y pull requests de GitHub',
    steps: [
      '1. Entra a https://github.com/settings/personal-access-tokens/new',
      '2. Elige solo el repositorio que usarás y da permiso de lectura y escritura a "Issues" y "Pull requests".',
      '3. Genera el token y cópialo.',
    ],
    fields: [{ key: 'token', label: 'Token de acceso personal', secret: true, envVar: 'GITHUB_TOKEN' }],
    build: () => ({ url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: `Bearer ${ref('GITHUB_TOKEN')}` } }),
  },
];

export const findPreset = (id: string | undefined, presets = PRESETS): Preset | undefined => presets.find((p) => p.id === id?.toLowerCase());

const READ_VERBS = new Set(['get', 'list', 'ls', 'search', 'read', 'find', 'fetch', 'query', 'describe', 'view', 'show', 'lookup', 'whoami', 'check']);
// Raíces de verbos de escritura: "creat" cubre create/creates/creating, etc. Ante la duda se trata como escritura.
const WRITE_STEMS = [
  'creat',
  'updat',
  'delet',
  'remov',
  'add',
  'mov',
  'set',
  'post',
  'put',
  'patch',
  'writ',
  'comment',
  'assign',
  'transit',
  'archiv',
  'attach',
  'upload',
  'merg',
  'clos',
  'open',
  'send',
  'edit',
  'renam',
  'reorder',
  'link',
  'label',
  'fork',
  'push',
  'run',
  'trigger',
];

/** "jira_getIssue" → ["jira", "get", "issue"]: separa por símbolos y por mayúsculas. */
const words = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Nombre de la herramienta sin el prefijo "mcp__servidor__". */
export const originalToolName = (exposed: string, server: string): string =>
  exposed.replace(new RegExp(`^mcp__${server.replace(/[^a-zA-Z0-9_-]/g, '_')}__`), '');

/**
 * Heurística por palabras del nombre: un verbo de lectura (get, list, search…) y ningún verbo de escritura. Ante la duda es escritura,
 * que siempre pregunta. No confía en anotaciones del servidor.
 */
export const isReadOnlyTool = (name: string): boolean => {
  const w = words(name);
  // El verbo de lectura va al principio o tras el nombre del servicio ("jira_get", "trello_list_boards").
  return w.slice(0, 2).some((t) => READ_VERBS.has(t)) && !w.some((t) => WRITE_STEMS.some((stem) => t.startsWith(stem)));
};

export function splitTools(exposed: string[], server: string): { read: string[]; write: string[] } {
  const read: string[] = [];
  const write: string[] = [];
  for (const t of exposed) (isReadOnlyTool(originalToolName(t, server)) ? read : write).push(originalToolName(t, server));
  return { read, write };
}

/** Inserta o reemplaza un servidor en el texto de agente.config.json, conservando el resto. */
export function mergeServer(configText: string | undefined, id: string, server: ServerJson & { autoApprove?: string[] }): string {
  const parsed: unknown = configText?.trim() ? JSON.parse(configText) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('agente.config.json no es un objeto JSON.');
  const config = parsed as { mcpServers?: Record<string, unknown> };
  config.mcpServers = { ...(config.mcpServers ?? {}), [id]: server };
  return `${JSON.stringify(config, null, 2)}\n`;
}
