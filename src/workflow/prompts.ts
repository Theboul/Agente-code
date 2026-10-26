import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type PromptName = 'plan' | 'implement' | 'fix' | 'issue-fetch' | 'issue-list' | 'commit' | 'pr' | 'sync';

/** Prompts por defecto. El desarrollador los sobrescribe con .agente/prompts/<nombre>.md (ver `agente init`). */
export const DEFAULT_PROMPTS: Record<PromptName, string> = {
  plan: `Vas a PLANIFICAR (sin modificar nada) cómo resolver esta tarea en el repositorio actual.

# Tarea {{issue.key}}
**{{issue.title}}**

{{issue.body}}

Explora el código con list_files, grep y read_file y responde con un plan en Markdown con estas secciones:
## Entendimiento — qué se pide, en una o dos frases.
## Archivos a tocar — lista con la ruta y qué cambia en cada uno.
## Pasos — ordenados y concretos.
## Pruebas — qué pruebas añadir o actualizar y cómo verificar.
## Riesgos o dudas — lo que el usuario debería confirmar.
No escribas código todavía.`,

  implement: `Implementa esta tarea siguiendo el plan aprobado. Estás en la rama {{branch}}.

# Tarea {{issue.key}}
**{{issue.title}}**

{{issue.body}}

# Plan aprobado
{{plan}}

Reglas: cambios mínimos y en el estilo del código existente; añade o actualiza pruebas; no hagas commit ni push (eso lo hace el flujo después); no modifiques archivos ajenos a la tarea.
Cuando termines, resume en pocas líneas qué cambiaste.`,

  fix: `La verificación automática falló. Corrige el problema sin romper lo ya hecho.

Comando: {{verify.command}}
Salida:
\`\`\`
{{verify.output}}
\`\`\`
Arregla la causa de fondo (no desactives ni borres pruebas para pasar la verificación).`,

  commit: `Escribe el mensaje de commit para estos cambios (Conventional Commits, en español).

Tarea {{issue.key}}: {{issue.title}}

Resumen de cambios:
{{diff.stat}}

Diff:
{{diff}}

Formato: primera línea "tipo(ámbito opcional): descripción" de máx. 72 caracteres (tipos: feat, fix, refactor, test, docs, chore), línea en blanco y un cuerpo breve con el porqué.
Si la tarea tiene clave, menciónala al final del cuerpo ("Refs: {{issue.key}}").
Responde SOLO con el mensaje, sin comillas ni bloques de código, y SIN líneas Co-Authored-By ni ninguna otra atribución.{{feedback}}`,

  pr: `Escribe la descripción (cuerpo) de un pull request en español, en Markdown.

Tarea {{issue.key}}: {{issue.title}}
{{issue.body}}

Plan aprobado:
{{plan}}

Cambios:
{{diff.stat}}

Verificación: {{verify}}
{{template}}
Incluye: ## Resumen, ## Cambios, ## Cómo probar. Termina con la línea "{{issue.closes}}" si no está vacía.
Responde SOLO con el cuerpo. No añadas firmas, créditos ni líneas "Generated with" / Co-Authored-By.`,

  sync: `Sincroniza el gestor de tareas con herramientas MCP para la issue "{{issue.key}}":
1. Añade un comentario con el enlace al pull request: {{pr.url}} (rama {{branch}}).
2. {{sync.status}}
Si alguna herramienta no existe, omite ese paso. Responde con una línea resumiendo qué hiciste.`,

  'issue-fetch': `Usa las herramientas MCP disponibles para leer la issue "{{ref}}" del gestor de tareas.
Responde SOLO con un bloque \`\`\`json con este formato: {"key": "...", "title": "...", "body": "descripción completa y criterios de aceptación", "url": "..."}`,

  'issue-list': `Usa las herramientas MCP disponibles para listar issues: {{query}}.
Devuelve como máximo 15. Responde SOLO con un bloque \`\`\`json: un arreglo de {"key": "...", "title": "...", "body": "resumen corto", "url": "..."}`,
};

export async function loadPrompt(root: string, name: PromptName, vars: Record<string, string | undefined>): Promise<string> {
  let template = DEFAULT_PROMPTS[name];
  try {
    template = await readFile(join(root, '.agente', 'prompts', `${name}.md`), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return renderTemplate(template, vars);
}

/** Sustituye {{clave}}; las claves desconocidas quedan vacías. */
export function renderTemplate(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, k: string) => vars[k] ?? '');
}
