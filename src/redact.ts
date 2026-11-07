const HIDDEN = '[oculto]';

// Formatos de claves reconocibles por su aspecto. Conservador a propósito: mejor dejar pasar algo raro que
// destrozar código normal con falsos positivos.
const TOKEN_PATTERNS: RegExp[] = [
  /AQ\.[A-Za-z0-9_-]{30,}/g, // Google Gemini (formato nuevo)
  /AIza[0-9A-Za-z_-]{30,}/g, // Google (formato clásico)
  /ATATT[A-Za-z0-9_=-]{20,}/g, // Atlassian
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI y Anthropic (sk-ant-…)
  /github_pat_[A-Za-z0-9_]{30,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /AKIA[0-9A-Z]{16}/g, // AWS
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** "Authorization: Bearer abc…" → conserva la palabra y oculta el valor. */
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi;
/** Líneas de .env o variables exportadas: CLAVE_API=valor, TOKEN: valor… (no toca MAX_TOKENS=4000). */
const ENV_LINE = /^(\s*(?:export\s+)?[A-Za-z0-9_]*(?:API_?KEY|SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE_KEY)\s*[=:]\s*)(.+)$/gim;
/** Pares JSON/objeto: "password": "valor". */
const JSON_PAIR = /("(?:[A-Za-z_]*(?:password|passwd|secret|token|api[_-]?key)[A-Za-z_]*)"\s*:\s*")([^"]{4,})(")/gi;

/** Oculta claves, tokens y contraseñas de un texto. */
export function redactText(text: string): string {
  let out = text;
  for (const re of TOKEN_PATTERNS) out = out.replace(re, HIDDEN);
  return out.replace(BEARER, `$1${HIDDEN}`).replace(ENV_LINE, `$1${HIDDEN}`).replace(JSON_PAIR, `$1${HIDDEN}$3`);
}

/** Copia profunda de un valor JSON con todas sus cadenas filtradas. No modifica el original. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  return value;
}
