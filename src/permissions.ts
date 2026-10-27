export type Decision = 'allow' | 'ask' | 'deny';

export type Asker = (question: string) => Promise<boolean>;

export interface Permissions {
  /** Pide confirmación al usuario (o la deniega si no hay terminal interactivo). */
  confirm: Asker;
  /** Pregunta abierta al usuario (herramienta ask_user). Sin terminal interactivo devuelve undefined. */
  ask?: (question: string) => Promise<string | undefined>;
  /** Aprobar todo sin preguntar (modo --yes). */
  autoApprove: boolean;
  allowedCommands: string[];
}

// Bloqueados siempre, incluso con --yes (ver `forbidden`).
const DENY_PATTERNS = [
  /\b(sudo|doas)\b/,
  /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba|z|da|k|c)?sh\b/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b[^\n]*\bof=\/dev\/(?!null\b)/,
  /\b(shutdown|reboot|poweroff)\b/,
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
