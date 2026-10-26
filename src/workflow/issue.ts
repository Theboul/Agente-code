import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { slugify } from '../git.js';

export const IssueSchema = z.object({
  key: z.string().optional(),
  title: z.string().min(1),
  body: z.string().default(''),
  url: z.string().optional(),
});
export type Issue = z.infer<typeof IssueSchema>;

export type IssueRef = { kind: 'file'; path: string } | { kind: 'tracker'; ref: string } | { kind: 'text'; text: string };

/** Distingue entre un archivo .md/.txt, una referencia de tracker (PROJ-123, #45, URL) o texto libre. */
export function classifyRef(ref: string, cwd: string): IssueRef {
  const r = ref.trim();
  if (/\.(md|txt)$/i.test(r) && existsSync(resolve(cwd, r))) return { kind: 'file', path: resolve(cwd, r) };
  if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(r) || /^#\d+$/.test(r) || /^[\w.-]+\/[\w.-]+#\d+$/.test(r) || /^https?:\/\/\S+$/.test(r)) {
    return { kind: 'tracker', ref: r };
  }
  return { kind: 'text', text: r };
}

/** Texto libre o archivo: la primera línea es el título, el resto el cuerpo. */
export function issueFromText(text: string, key?: string): Issue {
  const lines = text.trim().split('\n');
  const title = lines[0]!.replace(/^#+\s*/, '').trim();
  return IssueSchema.parse({ key, title, body: lines.slice(1).join('\n').trim() });
}

export function issueFromFile(path: string): Issue {
  return issueFromText(readFileSync(path, 'utf8'));
}

/** Extrae el primer bloque JSON (en ```json o suelto) de la respuesta de un modelo. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.search(/[[{]/);
  if (start < 0) throw new Error('La respuesta del modelo no contiene JSON.');
  const open = candidate[start]!;
  const close = open === '{' ? '}' : ']';
  const end = candidate.lastIndexOf(close);
  if (end < start) throw new Error('JSON incompleto en la respuesta del modelo.');
  return JSON.parse(candidate.slice(start, end + 1));
}

export const IssueListSchema = z.array(IssueSchema);

/** feat/proj-123-arreglar-login */
export function branchNameFor(issue: Issue, prefix: string): string {
  const key = issue.key ? slugify(issue.key, 20) : '';
  const title = slugify(issue.title, key ? 30 : 45);
  return `${prefix}${[key, title].filter(Boolean).join('-')}` || `${prefix}tarea`;
}
