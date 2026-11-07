import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { agenteHome } from './credentials.js';
import { redactText } from './redact.js';

/**
 * Memoria que el USUARIO decide guardar, en dos ámbitos:
 *  - proyecto: sección "Memoria del agente" de AGENTE.md (se versiona con el repo, la ve todo el equipo)
 *  - personal: ~/.agente/memory.md (preferencias tuyas, valen en todos tus proyectos)
 * Solo se escribe por orden del usuario (/remember): nunca por iniciativa del modelo, porque una nota persistente escrita a partir
 * de contenido externo (una issue, una web) sería una vía de inyección de instrucciones.
 */
export type MemoryScope = 'project' | 'user';

export const MEMORY_HEADING = '## Memoria del agente';
export const MAX_NOTE_CHARS = 500;
/** Tope de lo que se inyecta en el prompt por ámbito: una memoria enorme se comería el contexto en cada turno. */
export const MAX_MEMORY_CHARS = 6000;

export const projectMemoryFile = (cwd: string): string => join(cwd, 'AGENTE.md');
export const userMemoryFile = (): string => join(agenteHome(), 'memory.md');
export const memoryFile = (scope: MemoryScope, cwd: string): string => (scope === 'project' ? projectMemoryFile(cwd) : userMemoryFile());

export class MemoryError extends Error {}

/** Una sola línea, sin caracteres de control y de longitud razonable; rechaza lo que parezca un secreto. */
export function cleanNote(raw: string): string {
  const note = [...raw.replace(/\s+/g, ' ')]
    .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    .join('')
    .trim();
  if (!note) throw new MemoryError('La nota está vacía.');
  if (note.length > MAX_NOTE_CHARS) throw new MemoryError(`La nota es demasiado larga (${note.length} caracteres; máximo ${MAX_NOTE_CHARS}).`);
  if (redactText(note) !== note) throw new MemoryError('La nota parece contener un secreto (clave, token o contraseña). No se guarda.');
  return note;
}

const read = async (file: string): Promise<string> => readFile(file, 'utf8').catch(() => '');
const bullet = (note: string) => `- ${note}`;

/** Líneas de nota ("- texto") que hay en la sección de memoria. En la memoria personal, todo el archivo es memoria. */
export function parseNotes(text: string, scope: MemoryScope): string[] {
  let area = text;
  if (scope === 'project') {
    const i = text.indexOf(MEMORY_HEADING);
    if (i < 0) return [];
    const rest = text.slice(i + MEMORY_HEADING.length);
    const next = rest.search(/^## /m);
    area = next < 0 ? rest : rest.slice(0, next);
  }
  return area
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim());
}

export async function listNotes(scope: MemoryScope, cwd: string): Promise<string[]> {
  return parseNotes(await read(memoryFile(scope, cwd)), scope);
}

/** Añade una nota al final de su sección (la crea si hace falta). Devuelve el archivo escrito. */
export async function addNote(scope: MemoryScope, cwd: string, raw: string): Promise<string> {
  const note = cleanNote(raw);
  const file = memoryFile(scope, cwd);
  const current = await read(file);
  if (parseNotes(current, scope).includes(note)) throw new MemoryError('Esa nota ya existe.');

  let next: string;
  if (scope === 'user') {
    next = `${current.trimEnd() ? `${current.trimEnd()}\n` : '# Memoria personal de agente\n\n'}${bullet(note)}\n`;
  } else if (current.includes(MEMORY_HEADING)) {
    const i = current.indexOf(MEMORY_HEADING) + MEMORY_HEADING.length;
    const after = current.slice(i);
    const nextHeading = after.search(/^## /m);
    const sectionEnd = nextHeading < 0 ? current.length : i + nextHeading;
    next = `${current.slice(0, sectionEnd).trimEnd()}\n${bullet(note)}\n${nextHeading < 0 ? '' : `\n${current.slice(sectionEnd)}`}`;
  } else {
    next = `${current.trimEnd() ? `${current.trimEnd()}\n\n` : '# Instrucciones del proyecto\n\n'}${MEMORY_HEADING}\n${bullet(note)}\n`;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, next, scope === 'user' ? { mode: 0o600 } : undefined);
  if (scope === 'user') await chmod(file, 0o600);
  return file;
}

/** Borra la nota número `n` (empezando en 1). Devuelve el texto borrado. */
export async function removeNote(scope: MemoryScope, cwd: string, n: number): Promise<string> {
  const file = memoryFile(scope, cwd);
  const current = await read(file);
  const notes = parseNotes(current, scope);
  const target = notes[n - 1];
  if (target === undefined) throw new MemoryError(notes.length ? `No existe la nota ${n}. Hay ${notes.length}.` : 'No hay notas guardadas.');
  const lines = current.split('\n');
  const idx = lines.findIndex((l, i) => l === bullet(target) && (scope === 'user' || i > lines.findIndex((x) => x.startsWith(MEMORY_HEADING))));
  lines.splice(idx, 1);
  await writeFile(file, lines.join('\n'), scope === 'user' ? { mode: 0o600 } : undefined);
  return target;
}

/** Texto de la memoria personal para el prompt, recortado al tope. */
export async function loadUserMemory(): Promise<string> {
  const notes = parseNotes(await read(userMemoryFile()), 'user');
  return notes.map(bullet).join('\n').slice(0, MAX_MEMORY_CHARS);
}
