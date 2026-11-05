export type Decision = 'allow' | 'ask' | 'deny';

export type Asker = (question: string) => Promise<boolean>;

export type PermissionKind = 'edit' | 'create' | 'delete' | 'move' | 'command' | 'mcp' | 'web' | 'workflow';

/** Lo que el agente quiere hacer, con el detalle para mostrárselo al usuario antes de decidir. */
export interface PermissionRequest {
  kind: PermissionKind;
  title: string;
  target?: string;
  /** Líneas de vista previa; las que empiezan con "+ " o "- " se muestran como diff. */
  preview?: string[];
  question: string;
  /** Si existe, se ofrece "sí, y no volver a preguntar en esta sesión" para esa clave. */
  session?: { key: string; label: string };
}

/** `feedback`: lo que el usuario pidió hacer distinto. `reason`: motivo del sistema (p. ej. modo solo plan). */
export type PermissionReply = { allow: true } | { allow: false; feedback?: string; reason?: string };

/** preguntar: diálogo en cada cambio · edits: las ediciones de archivos se aceptan solas · plan: solo lectura, ningún cambio. */
export type PermissionMode = 'ask' | 'edits' | 'plan';

export const MODES: PermissionMode[] = ['ask', 'edits', 'plan'];

export const MODE_LABEL: Record<PermissionMode, string> = {
  ask: 'preguntar antes de cambiar',
  edits: 'aceptar ediciones solas',
  plan: 'solo plan (sin cambios)',
};

export const nextMode = (m: PermissionMode): PermissionMode => MODES[(MODES.indexOf(m) + 1) % MODES.length]!;

const PLAN_MODE_DENIED = 'Modo solo plan: no se permiten cambios ni comandos. Investiga con las herramientas de lectura y propón un plan.';
const BLOCKED_IN_PLAN: PermissionKind[] = ['edit', 'create', 'delete', 'move', 'command', 'mcp', 'workflow'];

export interface Permissions {
  /** Modo de permisos de la sesión (por defecto "ask"). Shift+Tab lo cambia en la sesión interactiva. */
  mode?: PermissionMode;
  /** Pide confirmación al usuario (o la deniega si no hay terminal interactivo). */
  confirm: Asker;
  /** Diálogo con opciones (sí / sí en esta sesión / no y decir qué hacer). Si falta, se usa `confirm`. */
  prompt?: (request: PermissionRequest) => Promise<PermissionReply>;
  /** Pregunta abierta al usuario (herramienta ask_user). Sin terminal interactivo devuelve undefined. */
  ask?: (question: string) => Promise<string | undefined>;
  /** Aprobar todo sin preguntar (modo --yes). */
  autoApprove: boolean;
  allowedCommands: string[];
}

// Lo que puede preceder al comando real sin dejar de ser "posición de comando": envoltorios, palabras clave del shell,
// intérpretes con -c (`bash -lc`) y asignaciones `VAR=1`.
const COMMAND_PREFIX = [
  'nohup|time|env|exec|eval|command|builtin|nice|setsid|xargs|stdbuf|!',
  'then|do|else|elif|if|while|until',
  'timeout\\s+\\S+',
  '(?:ba|z|da|k)?sh\\s+-\\w*c',
  '\\w+=\\S*',
].join('|');
// Apagado del sistema: solo si es el comando (inicio o tras ; & | ( { ` salto de línea), no si es texto de un argumento.
const SHUTDOWN_AS_COMMAND = new RegExp(`(?:^|[;&|\`({\\n])\\s*(?:(?:${COMMAND_PREFIX})\\s+)*(?:\\S*/)?(?:shutdown|reboot|poweroff)\\b`);

// Bloqueados siempre, incluso con --yes (ver `forbidden`).
const DENY_PATTERNS = [
  /\b(sudo|doas)\b/,
  /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba|z|da|k|c)?sh\b/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b[^\n]*\bof=\/dev\/(?!null\b)/,
  SHUTDOWN_AS_COMMAND,
  // `find … -exec reboot`: el programa va tras un argumento, no en posición de comando.
  /\s-exec(?:dir)?\s+(?:\S*\/)?(?:shutdown|reboot|poweroff)\b/,
  /\bsystemctl\s+(?:poweroff|reboot|halt)\b/,
  /:\(\)\s*\{/,
];
// Tras `git ... push`: fuerza, espejo, borrado remoto, refspec con "+" o ":rama".
const PUSH_DESTRUCTIVE = /(^|\s)(--force\S*|--mirror|--delete|-[a-zA-Z]*f[a-zA-Z]*|\+\S+|:\S+)(?=\s|$)/;
// Destinos de `rm -r` que borran el sistema, el home o el propio proyecto.
const RM_DANGEROUS_TARGET = /^(\/\*?|~\/?\*?|\$\{?HOME\}?\/?\*?|\.{1,2}\/?\*?|[a-zA-Z]:[\\/]?\*?)$/;
// Operadores de shell que permiten encadenar otro comando tras uno "permitido".
const CHAINING = /[;&|`$()<>\n]/;

// Opciones que escriben archivos, ejecutan programas o cambian de directorio aunque el prefijo esté permitido.
// `-O…` cubre `git diff -O<archivo>` (lee un archivo de órdenes) y `-O` de curl/wget (escribe a disco).
const UNSAFE_FLAG =
  /^(--output|--ext-diff|--textconv|--no-index|--open-files-in-pager|--script-shell|--prefix|--userconfig|--globalconfig|--registry|--cache)(=|$)|^-O/;
// Archivos con secretos que un comando "de solo lectura" no debe leer sin confirmación.
const SENSITIVE =
  /(^|[\\/])(\.env(?!\.(example|sample|template)$)(\.[^\\/]*)?|id_(rsa|dsa|ecdsa|ed25519)[^\\/]*|\.npmrc|\.netrc|\.pgpass|credentials)$|\.(pem|key|p12|pfx)$|[\\/]\.(ssh|aws|gnupg)([\\/]|$)/i;

function pushIsDestructive(text: string): boolean {
  const m = /\bgit\b[^;&|\n]*\bpush\b/.exec(text);
  return !!m && PUSH_DESTRUCTIVE.test(text.slice(m.index + m[0].length));
}

function rmIsDangerous(text: string): boolean {
  const tokens = text.split(/[\s;&|()`]+/);
  return tokens.some((t, i) => {
    if (t !== 'rm' && !t.endsWith('/rm')) return false;
    const args: string[] = [];
    for (const a of tokens.slice(i + 1)) {
      if (a === 'rm' || a.endsWith('/rm')) break;
      args.push(a);
    }
    const recursive = args.some((a) => a === '--recursive' || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a));
    return recursive && args.some((a) => !a.startsWith('-') && RM_DANGEROUS_TARGET.test(a));
  });
}

/** Comandos que nunca se ejecutan. Se evalúa también sin comillas ni barras para vencer `su""do`, `s\udo`… */
function forbidden(text: string): boolean {
  return DENY_PATTERNS.some((r) => r.test(text)) || pushIsDestructive(text) || rmIsDangerous(text);
}

function escapesProject(arg: string): boolean {
  return /^[\\/~]/.test(arg) || /^[a-zA-Z]:/.test(arg) || /(^|[\\/])\.\.($|[\\/])/.test(arg);
}

// Nombres de ejemplo de archivos y carpetas con secretos: un comodín que pueda coincidir con alguno pregunta.
const SECRET_FILES = ['.env', '.env.local', 'id_rsa', 'id_ed25519', 'server.pem', 'private.key', '.npmrc', '.netrc', '.pgpass', 'credentials'];
const SECRET_DIRS = ['.ssh', '.aws', '.gnupg'];
const GLOB_CHARS = /[*?[{]/;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Convierte un patrón del shell (`*`, `?`, `[a-c]`, `{a,b}`) en expresión regular, para un único segmento de ruta. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    const close = c === '[' ? glob.indexOf(']', i + 2) : c === '{' ? glob.indexOf('}', i + 1) : -1;
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[' && close > 0) {
      re += `[${glob
        .slice(i + 1, close)
        .replace(/^!/, '^')
        .replace(/\\/g, '\\\\')}]`;
      i = close;
    } else if (c === '{' && close > 0) {
      re += `(?:${glob
        .slice(i + 1, close)
        .split(',')
        .map(escapeRegExp)
        .join('|')})`;
      i = close;
    } else re += escapeRegExp(c);
  }
  return new RegExp(`^${re}$`);
}

/** ¿Puede este segmento con comodines coincidir con alguno de los nombres? `*`, `?` y `[...]` al inicio no cubren archivos ocultos. */
function globHits(segment: string, names: string[]): boolean {
  if (!GLOB_CHARS.test(segment)) return false;
  const re = globToRegExp(segment);
  const hidesDotfiles = /^[*?[]/.test(segment) && !segment.includes('{');
  return names.some((n) => re.test(n) && !(hidesDotfiles && n.startsWith('.')));
}

function globReachesSecrets(path: string): boolean {
  const segments = path.split(/[\\/]/).filter(Boolean);
  const last = segments.pop();
  return segments.some((s) => globHits(s, SECRET_DIRS)) || (last !== undefined && globHits(last, [...SECRET_FILES, ...SECRET_DIRS]));
}

/**
 * Argumento que saca a un comando permitido de su uso de solo lectura dentro del proyecto.
 * Se evalúa tal como lo vería el shell: sin comillas (`.e"n"v` es `.env`) y también sin barras invertidas (`.e\nv`),
 * y los comodines que podrían alcanzar secretos (`.e[n]v`, `.e*`, `*.pem`) cuentan como sospechosos.
 */
function unsafeArg(raw: string): boolean {
  const sinComillas = raw.replace(/['"]/g, '');
  const variants = new Set([sinComillas, sinComillas.replace(/\\/g, '')]);
  for (const arg of variants) {
    if (UNSAFE_FLAG.test(arg)) return true;
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
    if ([arg, value].some((a) => escapesProject(a) || SENSITIVE.test(a) || globReachesSecrets(a))) return true;
  }
  return false;
}

export function classifyCommand(command: string, allowed: string[]): Decision {
  const cmd = command.trim();
  if (forbidden(cmd) || forbidden(cmd.replace(/['"\\]/g, ''))) return 'deny';
  if (CHAINING.test(cmd)) return 'ask';
  if (!allowed.some((p) => cmd === p || cmd.startsWith(`${p} `))) return 'ask';
  return cmd.split(/\s+/).slice(1).some(unsafeArg) ? 'ask' : 'allow';
}

export async function authorize(perms: Permissions, decision: Decision, question: string): Promise<boolean> {
  if (decision === 'deny') return false;
  if (decision === 'allow' || perms.autoApprove) return true;
  return perms.confirm(question);
}

/** Como `authorize`, pero usa el diálogo con opciones cuando hay uno y devuelve la indicación del usuario si rechaza. */
export async function authorizeDetailed(perms: Permissions, decision: Decision, request: PermissionRequest): Promise<PermissionReply> {
  if (decision === 'deny') return { allow: false };
  if (decision === 'allow' || perms.autoApprove) return { allow: true };
  if (perms.mode === 'plan' && BLOCKED_IN_PLAN.includes(request.kind)) return { allow: false, reason: PLAN_MODE_DENIED };
  if (perms.mode === 'edits' && (request.kind === 'edit' || request.kind === 'create')) return { allow: true };
  if (perms.prompt) return perms.prompt(request);
  return (await perms.confirm(request.question)) ? { allow: true } : { allow: false };
}

/** Texto que ve el modelo cuando el usuario rechaza: incluye lo que pidió hacer distinto. */
export function denialMessage(reply: PermissionReply): string {
  if (!reply.allow && reply.reason) return `DENEGADO: ${reply.reason}`;
  const feedback = !reply.allow && reply.feedback ? ` El usuario indica: ${reply.feedback}` : '';
  return `DENEGADO por el usuario.${feedback}`;
}

const CHAIN_OR_ESCAPE = /[;&|`$()<>\n]|(^|\s)(\.\.|~|\/)/;
const SECRET_HINT = /(\.env|id_rsa|id_ed25519|\.pem|\.key|\.ssh|\.aws|\.npmrc|credentials)/i;
// Programas cuyo primer argumento es el subcomando que importa (git commit, npm run…).
const SUBCOMMAND_TOOLS = new Set(['git', 'npm', 'pnpm', 'yarn', 'npx', 'cargo', 'go', 'docker', 'make', 'pip', 'python', 'node']);

/**
 * Clave para "no volver a preguntar en esta sesión" de un comando, o undefined si no se debe ofrecer:
 * comandos encadenados, que salen del proyecto o tocan archivos con secretos siempre preguntan.
 */
export function commandSessionKey(command: string): { key: string; label: string } | undefined {
  const cmd = command.trim();
  if (!cmd || CHAIN_OR_ESCAPE.test(cmd) || SECRET_HINT.test(cmd)) return undefined;
  const [first, second] = cmd.split(/\s+/);
  const prefix = first && second && SUBCOMMAND_TOOLS.has(first) && !second.startsWith('-') ? `${first} ${second}` : first;
  return prefix ? { key: `cmd:${prefix}`, label: `los comandos "${prefix} …"` } : undefined;
}
