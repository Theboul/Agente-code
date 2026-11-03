import { classifyRef } from './workflow/issue.js';

export const COMMANDS = ['chat', 'work', 'ship', 'issues', 'init'] as const;
export type Command = (typeof COMMANDS)[number];

export interface Invocation {
  cmd: Command;
  args: string[];
  /** `agente "pregunta"`: abre la sesión y envía esto como primer mensaje. */
  initialPrompt?: string;
  /** Una sola palabra parecida a un comando ("isues"): se sugiere en lugar de abrir el chat con ella. */
  suggest?: Command;
}

/** Distancia de edición (Levenshtein), suficiente para detectar erratas de comandos cortos. */
export function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

/**
 * Qué pidió el usuario en la línea de comandos:
 *   agente                 → sesión
 *   agente work X          → flujo (comando explícito)
 *   agente PROJ-123 | #45 | URL | tarea.md → flujo directo, sin escribir "work"
 *   agente "explica esto"  → sesión con ese primer mensaje
 */
export function parseInvocation(positionals: string[], cwd: string): Invocation {
  const [first, ...rest] = positionals;
  if (!first) return { cmd: 'chat', args: [] };
  if ((COMMANDS as readonly string[]).includes(first)) return { cmd: first as Command, args: rest };

  const text = positionals.join(' ').trim();
  if (classifyRef(text, cwd).kind !== 'text') return { cmd: 'work', args: [text] };

  if (positionals.length === 1) {
    const near = COMMANDS.find((c) => distance(first.toLowerCase(), c) <= 2 && first.length >= 4);
    if (near) return { cmd: 'chat', args: [], suggest: near };
  }
  return { cmd: 'chat', args: [], initialPrompt: text };
}
