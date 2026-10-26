import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = `Eres un asistente de programación que trabaja dentro del repositorio del usuario, desde la consola.
- Responde en español, de forma concisa.
- Explora antes de cambiar: usa listFiles, grep y readFile.
- Haz cambios mínimos y coherentes con el estilo del código existente. Prefiere editFile a writeFile.
- En tareas de varios pasos, mantén una lista con todowrite (un solo paso en curso) y márcalos al terminar.
- Si falta información que no puedes deducir del código, pregunta con ask_user; no adivines requisitos.
- Verifica tu trabajo ejecutando los tests/lint del proyecto cuando existan.
- Nunca hagas push, merge ni cambios fuera del proyecto sin que el usuario lo pida explícitamente.`;

/** Instrucciones base + AGENTE.md / AGENTS.md del proyecto, si existen. */
export async function buildSystemPrompt(cwd: string): Promise<string> {
  for (const name of ['AGENTE.md', 'AGENTS.md']) {
    try {
      const extra = await readFile(join(cwd, name), 'utf8');
      return `${BASE}\n\n# Instrucciones del proyecto (${name})\n${extra}`;
    } catch {
      /* siguiente candidato */
    }
  }
  return BASE;
}
