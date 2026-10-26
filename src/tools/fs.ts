import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { authorize, type Permissions } from '../permissions.js';

const IGNORED = new Set(['node_modules', '.git', 'dist', '.agente']);
const MAX_READ_CHARS = 60_000;

/** Resuelve una ruta y garantiza que queda dentro del directorio de trabajo. */
export function safePath(cwd: string, p: string): string {
  const abs = resolve(cwd, p);
  const rel = relative(cwd, abs);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new Error(`Ruta fuera del proyecto: ${p}`);
  }
  return abs;
}

/** Reemplazo exacto: old_string debe aparecer una sola vez (salvo replace_all). */
export function applyEdit(content: string, oldStr: string, newStr: string, replaceAll = false): string {
  if (oldStr === newStr) throw new Error('old_string y new_string son idénticos.');
  const count = oldStr === '' ? 0 : content.split(oldStr).length - 1;
  if (count === 0) throw new Error('old_string no se encontró en el archivo.');
  if (count > 1 && !replaceAll) {
    throw new Error(`old_string aparece ${count} veces; añade más contexto o usa replace_all.`);
  }
  return replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, () => newStr);
}

export async function* walk(root: string, dir = root): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(root, full);
    else if (entry.isFile()) yield relative(root, full).split(sep).join('/');
  }
}

export function fsTools(cwd: string, perms: Permissions) {
  return {
    read_file: tool({
      description: 'Lee un archivo del proyecto. Devuelve el contenido con números de línea.',
      inputSchema: z.object({
        path: z.string().describe('Ruta relativa al proyecto'),
        offset: z.number().int().min(1).optional().describe('Línea inicial (1-based)'),
        limit: z.number().int().min(1).optional().describe('Número máximo de líneas'),
      }),
      execute: async ({ path, offset = 1, limit }) => {
        const text = await readFile(safePath(cwd, path), 'utf8');
        const lines = text.split('\n').slice(offset - 1, limit ? offset - 1 + limit : undefined);
        const out = lines.map((l, i) => `${offset + i}\t${l}`).join('\n');
        return out.length > MAX_READ_CHARS ? out.slice(0, MAX_READ_CHARS) + '\n…[truncado, usa offset/limit]' : out;
      },
    }),

    list_files: tool({
      description: 'Lista archivos del proyecto, opcionalmente filtrando con una subcadena o glob simple (*, **).',
      inputSchema: z.object({ pattern: z.string().optional().describe('Ej: "src/**/*.ts" o "config"') }),
      execute: async ({ pattern }) => {
        const re = pattern ? globToRegExp(pattern) : undefined;
        const out: string[] = [];
        for await (const f of walk(cwd)) {
          if (!re || re.test(f)) out.push(f);
          if (out.length >= 500) break;
        }
        return out.join('\n') || '(sin resultados)';
      },
    }),

    grep: tool({
      description: 'Busca una expresión regular en los archivos del proyecto. Devuelve archivo:línea:texto.',
      inputSchema: z.object({
        pattern: z.string().describe('Expresión regular (JavaScript)'),
        glob: z.string().optional().describe('Limitar a archivos que casen con este glob'),
      }),
      execute: async ({ pattern, glob }) => {
        const re = new RegExp(pattern);
        const fileRe = glob ? globToRegExp(glob) : undefined;
        const hits: string[] = [];
        for await (const f of walk(cwd)) {
          if (fileRe && !fileRe.test(f)) continue;
          let text: string;
          try {
            const abs = join(cwd, f);
            if ((await stat(abs)).size > 1_000_000) continue;
            text = await readFile(abs, 'utf8');
          } catch {
            continue;
          }
          if (text.includes('\0')) continue;
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i]!)) hits.push(`${f}:${i + 1}:${lines[i]!.slice(0, 300)}`);
            if (hits.length >= 200) return hits.join('\n') + '\n…[límite de 200 resultados]';
          }
        }
        return hits.join('\n') || '(sin coincidencias)';
      },
    }),

    write_file: tool({
      description: 'Crea o sobrescribe un archivo completo. Para cambios parciales usa edit_file.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => {
        const abs = safePath(cwd, path);
        if (!(await authorize(perms, 'ask', `¿Escribir ${path} (${content.length} caracteres)?`))) {
          return 'DENEGADO por el usuario.';
        }
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content);
        return `Escrito ${path}`;
      },
    }),

    edit_file: tool({
      description:
        'Edita un archivo reemplazando old_string por new_string. old_string debe ser único en el archivo (incluye contexto suficiente).',
      inputSchema: z.object({
        path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
      }),
      execute: async ({ path, old_string, new_string, replace_all }) => {
        const abs = safePath(cwd, path);
        const next = applyEdit(await readFile(abs, 'utf8'), old_string, new_string, replace_all);
        if (!(await authorize(perms, 'ask', `¿Editar ${path}?\n- ${preview(old_string)}\n+ ${preview(new_string)}`))) {
          return 'DENEGADO por el usuario.';
        }
        await writeFile(abs, next);
        return `Editado ${path}`;
      },
    }),
  };
}

function preview(s: string): string {
  const one = s.split('\n').slice(0, 6).join('\n  ');
  return one.length > 400 ? one.slice(0, 400) + '…' : one;
}

export function globToRegExp(glob: string): RegExp {
  if (!/[*?]/.test(glob)) return new RegExp(glob.replace(/[.+^${}()|[\]\\]/g, '\\$&'));
  const src = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*');
  return new RegExp(`^${src}$`);
}
