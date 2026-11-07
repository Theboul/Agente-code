import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { fileOf, loadSession, readAll, type SessionRecord, saveSession } from './session.js';

/** Texto de un mensaje para buscar y exportar: texto, llamadas a herramientas y sus resultados. */
export function messageText(m: ModelMessage): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .map((part) => {
      const p = part as { type: string; text?: string; toolName?: string; input?: unknown; output?: { value?: unknown } };
      if (p.type === 'text') return p.text ?? '';
      if (p.type === 'tool-call') return `${p.toolName}(${JSON.stringify(p.input ?? {})})`;
      if (p.type === 'tool-result') return typeof p.output?.value === 'string' ? p.output.value : JSON.stringify(p.output ?? '');
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export interface SearchHit {
  id: string;
  title: string;
  updatedAt: string;
  /** Cuántas veces aparece el texto en la sesión. */
  matches: number;
  /** Fragmento alrededor de la primera coincidencia. */
  snippet: string;
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Busca texto (sin distinguir mayúsculas) en todas las sesiones del proyecto: más coincidencias primero, a igualdad la más reciente. */
export async function searchSessions(dir: string, query: string, limit = 10): Promise<SearchHit[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const rec of await readAll(dir)) {
    let matches = 0;
    let snippet = '';
    for (const m of rec.messages) {
      const text = flat(messageText(m));
      const lower = text.toLowerCase();
      for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) {
        if (!matches) snippet = `${at > 40 ? '…' : ''}${text.slice(Math.max(0, at - 40), at + q.length + 60)}${at + q.length + 60 < text.length ? '…' : ''}`;
        matches++;
      }
    }
    if (matches) hits.push({ id: rec.id, title: rec.customTitle ?? rec.title, updatedAt: rec.updatedAt, matches, snippet });
  }
  return hits.sort((a, b) => b.matches - a.matches || b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
}

/** Resuelve una sesión por id o prefijo único. Exige una referencia: borrar "la última" por descuido sería peligroso. */
async function resolve(dir: string, ref: string, except?: string): Promise<SessionRecord> {
  if (!ref.trim() || ref === 'last') throw new Error('Indica el id de la sesión (basta el principio). Mira las disponibles con /sessions.');
  return loadSession(dir, ref, except);
}

/** Borra una sesión. La sesión activa no se puede borrar (se seguiría guardando). Devuelve la sesión borrada. */
export async function deleteSession(dir: string, ref: string, currentId?: string): Promise<SessionRecord> {
  const rec = await resolve(dir, ref);
  if (rec.id === currentId) throw new Error('Esa es la sesión activa: usa /clear para empezar otra y bórrala después.');
  await rm(fileOf(dir, rec.id), { force: true });
  return rec;
}

/** Pone un título propio a una sesión. */
export async function renameSession(dir: string, ref: string, title: string): Promise<SessionRecord> {
  const clean = flat(title).slice(0, 70);
  if (!clean) throw new Error('El título está vacío.');
  const rec = await resolve(dir, ref);
  const next = { ...rec, customTitle: clean };
  await saveSession(dir, next);
  return next;
}

const ROLE: Record<string, string> = { user: 'Usuario', assistant: 'Asistente', tool: 'Herramienta', system: 'Sistema' };

/** Sesión en Markdown legible (los resultados largos se recortan). */
export function sessionToMarkdown(rec: SessionRecord): string {
  const head = [
    `# ${rec.customTitle ?? rec.title}`,
    '',
    `- Sesión: \`${rec.id}\``,
    `- Modelo: ${rec.model}`,
    `- Creada: ${rec.createdAt} · Actualizada: ${rec.updatedAt}`,
    '',
  ];
  const body = rec.messages.map((m) => {
    const text = messageText(m);
    return `## ${ROLE[m.role] ?? m.role}\n\n${m.role === 'tool' && text.length > 800 ? `${text.slice(0, 800)}\n…[recortado]` : text}\n`;
  });
  return [...head, ...body].join('\n');
}

/** Exporta una sesión a `<carpeta de sesiones>/exports/<id>.md` (solo legible por el dueño). Devuelve la ruta. */
export async function exportSession(dir: string, ref: string): Promise<string> {
  const rec = await resolve(dir, ref);
  const out = join(dir, 'exports');
  await mkdir(out, { recursive: true });
  const file = join(out, `${rec.id}.md`);
  await writeFile(file, sessionToMarkdown(rec), { mode: 0o600 });
  return file;
}
