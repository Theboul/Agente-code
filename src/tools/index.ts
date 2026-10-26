import type { ToolSet } from 'ai';
import type { Permissions } from '../permissions.js';
import { bashTool } from './bash.js';
import { fsTools } from './fs.js';

export function nativeTools(cwd: string, perms: Permissions): ToolSet {
  return { ...fsTools(cwd, perms), bash: bashTool(cwd, perms) };
}

/** Herramientas de solo lectura, para la etapa de planificación. */
export function readOnlyTools(cwd: string, perms: Permissions): ToolSet {
  const { read_file, list_files, grep } = fsTools(cwd, perms);
  return { read_file, list_files, grep };
}
