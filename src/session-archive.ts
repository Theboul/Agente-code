import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { redactDeep } from './redact.js';

export interface CompactionArchive {
  sessionId: string;
  /** "summary": se resumió lo anterior · "prune": solo se podaron resultados de herramientas. */
  reason: 'summary' | 'prune';
  /** Mensajes tal como eran antes de compactar (los que se resumen o se podan). */
  messages: ModelMessage[];
}

/**
 * Guarda el original de lo que se compacta en `<carpeta de sesiones>/archive/`, con los secretos ocultos y permisos
 * solo para el dueño. La conversación activa queda compacta, pero el detalle no se pierde. Devuelve la ruta escrita.
 */
export async function archiveCompaction(sessionDir: string, a: CompactionArchive, now = new Date()): Promise<string> {
  const dir = join(sessionDir, 'archive');
  await mkdir(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `${a.sessionId}-${stamp}-${a.reason}.json`);
  await writeFile(file, JSON.stringify({ sessionId: a.sessionId, at: now.toISOString(), reason: a.reason, messages: redactDeep(a.messages) }), { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}
