import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { agenteHome } from './credentials.js';
import { agentDir, repoRoot } from './git.js';
import { redactDeep } from './redact.js';

/** Una conversación del chat guardada en disco, para retomarla después. */
export interface SessionRecord {
  id: string;
  cwd: string;
  title: string;
  /** Título puesto por el usuario (/sessions rename); manda sobre el que se deduce del primer mensaje. */
  customTitle?: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messages: ModelMessage[];
}

export type SessionSummary = Pick<SessionRecord, 'id' | 'title' | 'model' | 'updatedAt'> & { messages: number };

/** Sesiones que se conservan por proyecto; las más antiguas se borran al crear una nueva. */
export const KEEP_SESSIONS = 30;

const ROLES = new Set(['user', 'assistant', 'system', 'tool']);

/**
 * Carpeta de sesiones del proyecto. En un repo git va dentro de .git/agente (como los registros de `work`),
 * así no ensucia el árbol de trabajo; fuera de un repo, en ~/.agente/sessions/<hash de la carpeta>.
 */
export async function sessionsDir(cwd: string): Promise<string> {
  const root = await repoRoot(cwd);
  if (root) return join(await agentDir(root), 'sessions');
  return join(agenteHome(), 'sessions', createHash('sha1').update(cwd).digest('hex').slice(0, 12));
}

/** 20261105-001500-a3f9: ordenable por fecha y corto de escribir. */
export function newSessionId(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

/** Título legible: el primer mensaje del usuario, en una línea. */
export function sessionTitle(messages: ModelMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  const text =
    typeof first?.content === 'string' ? first.content : Array.isArray(first?.content) ? first.content.map((p) => ('text' in p ? p.text : '')).join(' ') : '';
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 70 ? `${line.slice(0, 69)}…` : line || '(sin título)';
}

export const fileOf = (dir: string, id: string): string => join(dir, `${id}.json`);

/**
 * Escritura atómica: si el proceso muere a mitad, la sesión anterior queda intacta. En disco los secretos van ocultos
 * (claves, tokens, líneas de .env) y el archivo es solo del dueño; la conversación en memoria no se modifica.
 */
export async function saveSession(dir: string, rec: SessionRecord): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = fileOf(dir, rec.id);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(redactDeep(rec)), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

function parseRecord(text: string, file: string): SessionRecord {
  const rec = JSON.parse(text) as Partial<SessionRecord>;
  const ok =
    typeof rec.id === 'string' &&
    typeof rec.updatedAt === 'string' &&
    Array.isArray(rec.messages) &&
    rec.messages.every((m) => typeof m === 'object' && m !== null && ROLES.has((m as { role?: string }).role ?? ''));
  if (!ok) throw new Error(`La sesión ${file} está dañada o no es de esta versión.`);
  return { cwd: '', title: '', model: '', createdAt: rec.updatedAt!, ...rec } as SessionRecord;
}

export async function readAll(dir: string): Promise<SessionRecord[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: SessionRecord[] = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      out.push(parseRecord(await readFile(join(dir, name), 'utf8'), name));
    } catch {} // una sesión ilegible no impide ver las demás
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Sesiones del proyecto, la más reciente primero. */
export async function listSessions(dir: string): Promise<SessionSummary[]> {
  return (await readAll(dir)).map((r) => ({ id: r.id, title: r.customTitle ?? r.title, model: r.model, updatedAt: r.updatedAt, messages: r.messages.length }));
}

/**
 * Carga una sesión por id completo o prefijo único; `last` (o vacío) es la más reciente.
 * `except` descarta una sesión (la actual, al hacer /resume dentro del chat).
 */
export async function loadSession(dir: string, ref = 'last', except?: string): Promise<SessionRecord> {
  const all = (await readAll(dir)).filter((r) => r.id !== except);
  if (!all.length) throw new Error('No hay sesiones guardadas en este proyecto.');
  if (ref === 'last') return all[0]!;
  const exact = all.find((r) => r.id === ref);
  if (exact) return exact;
  const byPrefix = all.filter((r) => r.id.startsWith(ref));
  if (byPrefix.length === 1) return byPrefix[0]!;
  if (byPrefix.length > 1) throw new Error(`"${ref}" coincide con varias sesiones; escribe más caracteres del id.`);
  throw new Error(`No existe la sesión "${ref}". Mira las disponibles con: agente sessions`);
}

/** Borra las sesiones más antiguas y deja `keep`. */
export async function pruneSessions(dir: string, keep = KEEP_SESSIONS): Promise<void> {
  const all = await readAll(dir);
  await Promise.all(all.slice(keep).map((r) => rm(fileOf(dir, r.id), { force: true })));
}

/** Fecha en hora local (el id de la sesión también está en hora local). */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
